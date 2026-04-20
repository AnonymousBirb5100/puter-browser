/**
 * Session store and runner.
 *
 * A "session" is one end-to-end scramdiff operation kicked off from the GUI:
 *
 *   - record:  run direct with ND capture, write a trace file, done.
 *   - replay:  load a trace file, run scramjet against the recorded target
 *              with ND replay seeded, diff against the recorded direct run.
 *   - diff:    spin up both harnesses live, diff.
 *
 * Each session is assigned an id and a Session record; the server exposes
 * the record + a live SSE event stream for progress. Sessions persist for
 * the lifetime of the server process — we're not trying to solve durable
 * history; a user who wants history should save the trace file from a record
 * session and a JSON report from a replay session.
 *
 * Breakpoint semantics: when a replay session is started with a breakpoint,
 * the runner kicks off withDriver in the background and waits. The scramjet
 * harness hits the probe's `debugger;` statement; the harness fires the
 * Debugger.paused CDP event, which we forward as a session event. The UI
 * shows a paused indicator + a Resume button. Resume posts to
 * /api/sessions/:id/resume, which calls the DriverControls.resumeScramjet;
 * the page continues until it hits the next (unconfigured) debugger or
 * finishes the run.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withDriver, type DriverControls } from "../driver/index.ts";
import { diffRuns } from "../diff/diff.ts";
import type {
	DiffIssue,
	DiffReport,
	NDCapture,
	RecordedTrace,
	RunArtifacts,
} from "../trace.ts";

export type SessionMode = "record" | "replay" | "diff";
export type SessionStatus =
	| "pending"
	| "running"
	| "paused"
	| "completed"
	| "errored"
	| "canceled";

export type SessionBreakpoint = {
	api: string;
	op?: "call" | "construct" | "get" | "set";
	matchIndex: number;
	/**
	 * If true, also spin up a direct (non-scramjet) Chromium window with the
	 * same breakpoint so the user can inspect both sides paused at the
	 * conceptually-same call. Only valid on replay sessions. When true, the
	 * session runs sides="both" and the driver paralleizes the two runs so
	 * they can both halt concurrently.
	 */
	alsoDirect?: boolean;
};

export type PauseInfo = {
	at: string;
	reason: string;
	side: "direct" | "scramjet";
	raw?: any;
};

export type Session = {
	id: string;
	mode: SessionMode;
	status: SessionStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	/** record / diff: the target URL. replay: pulled from the trace file. */
	target: string;
	/** record: where the trace was saved. replay: the loaded trace file. */
	tracePath?: string;
	/** replay: the breakpoint configured for this session, if any. */
	breakpoint?: SessionBreakpoint;
	/** Rolling log lines from the driver. Bounded at MAX_LOG_LINES. */
	log: string[];
	/** Last known progress string ("navigating…", "diffing runs…"). */
	progress?: string;
	/** Completed runs produce a report. */
	report?: DiffReport;
	/** Precomputed facets for the issue browser. */
	facets?: IssueFacets;
	/** record sessions produce this counter for the summary row. */
	ndSummary?: { totalCaptures: number; apiPaths: number };
	/** If status=errored, the error message. */
	error?: string;
	/**
	 * If status=paused, per-side pause snapshots. At least one side will be
	 * non-null while the session is paused; both may be populated when the
	 * breakpoint is applied to both harnesses and both have halted.
	 */
	pauses?: {
		direct?: PauseInfo;
		scramjet?: PauseInfo;
	};
};

export type IssueFacets = {
	total: number;
	byKind: Record<string, number>;
	byApi: Array<{ api: string; count: number }>;
};

const MAX_LOG_LINES = 5000;

export type SessionEvent =
	| { type: "state"; session: PublicSession }
	| { type: "log"; id: string; line: string; at: string }
	| { type: "progress"; id: string; progress: string }
	| {
			type: "paused";
			id: string;
			side: "direct" | "scramjet";
			pause: PauseInfo;
	  }
	| { type: "resumed"; id: string; side: "direct" | "scramjet" }
	| { type: "completed"; id: string }
	| { type: "error"; id: string; message: string };

/** Public view: omit heavy fields (full report, full log) that clients fetch on demand. */
export type PublicSession = Omit<Session, "report" | "log"> & {
	logTail: string[];
	hasReport: boolean;
	issueCount?: number;
};

function toPublic(s: Session): PublicSession {
	return {
		id: s.id,
		mode: s.mode,
		status: s.status,
		createdAt: s.createdAt,
		startedAt: s.startedAt,
		completedAt: s.completedAt,
		target: s.target,
		tracePath: s.tracePath,
		breakpoint: s.breakpoint,
		progress: s.progress,
		facets: s.facets,
		ndSummary: s.ndSummary,
		error: s.error,
		pauses: s.pauses,
		logTail: s.log.slice(-20),
		hasReport: !!s.report,
		issueCount: s.report ? s.report.issues.length : undefined,
	};
}

type SessionInternal = Session & {
	/** Driver controls, live while the run is in progress. */
	controls?: DriverControls;
	/** Promise that resolves when the run finishes. */
	done?: Promise<void>;
	/** Optional cancel signal from /cancel. */
	canceling?: boolean;
};

export class SessionStore extends EventEmitter {
	private map = new Map<string, SessionInternal>();
	private tracesDir: string;

	constructor(opts: { tracesDir: string }) {
		super();
		this.setMaxListeners(0);
		this.tracesDir = opts.tracesDir;
	}

	async ensureTracesDir() {
		await mkdir(this.tracesDir, { recursive: true });
	}

	list(): PublicSession[] {
		return Array.from(this.map.values())
			.sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))
			.map(toPublic);
	}

	get(id: string): PublicSession | null {
		const s = this.map.get(id);
		return s ? toPublic(s) : null;
	}

	/** Return the sliced issue list + total after filtering. */
	issuesPage(
		id: string,
		opts: {
			offset: number;
			limit: number;
			kind?: string;
			api?: string;
			q?: string;
		}
	): { total: number; issues: DiffIssue[] } | null {
		const s = this.map.get(id);
		if (!s || !s.report) return null;
		const q = opts.q ? opts.q.toLowerCase() : "";
		const all = s.report.issues.filter((i) => {
			if (opts.kind && i.kind !== opts.kind) return false;
			if (opts.api && i.api !== opts.api) return false;
			if (q && !i.message.toLowerCase().includes(q)) return false;
			return true;
		});
		const page = all.slice(opts.offset, opts.offset + opts.limit);
		return { total: all.length, issues: page };
	}

	getReport(id: string): DiffReport | null {
		const s = this.map.get(id);
		return s?.report ?? null;
	}

	async listTraces(): Promise<
		Array<{
			name: string;
			path: string;
			size: number;
			mtime: string;
			target?: string;
			recordedAt?: string;
		}>
	> {
		try {
			const entries = await readdir(this.tracesDir);
			const traces: Array<{
				name: string;
				path: string;
				size: number;
				mtime: string;
				target?: string;
				recordedAt?: string;
			}> = [];
			for (const name of entries) {
				if (!name.endsWith(".trace.json")) continue;
				const path = resolve(join(this.tracesDir, name));
				try {
					const st = await stat(path);
					if (!st.isFile()) continue;
					let target: string | undefined, recordedAt: string | undefined;
					try {
						const raw = await readFile(path, "utf-8");
						const obj = JSON.parse(raw);
						target = typeof obj.target === "string" ? obj.target : undefined;
						recordedAt =
							typeof obj.recordedAt === "string" ? obj.recordedAt : undefined;
					} catch {}
					traces.push({
						name,
						path,
						size: st.size,
						mtime: st.mtime.toISOString(),
						target,
						recordedAt,
					});
				} catch {}
			}
			traces.sort((a, b) => (b.mtime < a.mtime ? -1 : 1));
			return traces;
		} catch {
			return [];
		}
	}

	/**
	 * Start a record session: direct-only run with ND capture enabled. Saves
	 * the resulting RunArtifacts as a RecordedTrace.
	 */
	startRecord(args: { target: string; headless?: boolean }): PublicSession {
		const id = randomUUID();
		const s: SessionInternal = {
			id,
			mode: "record",
			status: "pending",
			createdAt: new Date().toISOString(),
			target: args.target,
			log: [],
		};
		this.map.set(id, s);
		this.emitState(s);

		s.done = this.runRecord(s, args).catch((e) => this.fail(s, e));
		return toPublic(s);
	}

	/**
	 * Start a replay session: scramjet-only run against a previously recorded
	 * trace, with optional breakpoint.
	 */
	startReplay(args: {
		tracePath: string;
		headless?: boolean;
		breakpoint?: SessionBreakpoint;
	}): PublicSession {
		const id = randomUUID();
		const s: SessionInternal = {
			id,
			mode: "replay",
			status: "pending",
			createdAt: new Date().toISOString(),
			target: "<pending trace load>",
			tracePath: args.tracePath,
			breakpoint: args.breakpoint,
			log: [],
		};
		this.map.set(id, s);
		this.emitState(s);

		s.done = this.runReplay(s, args).catch((e) => this.fail(s, e));
		return toPublic(s);
	}

	/** Start a live diff session — the classic scramdiff run. */
	startDiff(args: { target: string; headless?: boolean }): PublicSession {
		const id = randomUUID();
		const s: SessionInternal = {
			id,
			mode: "diff",
			status: "pending",
			createdAt: new Date().toISOString(),
			target: args.target,
			log: [],
		};
		this.map.set(id, s);
		this.emitState(s);

		s.done = this.runDiff(s, args).catch((e) => this.fail(s, e));
		return toPublic(s);
	}

	/**
	 * Resume a paused session.
	 *   side: "scramjet" | "direct" | "both"
	 * Returns false if the requested side isn't paused.
	 *
	 * When a session has both sides paused and you call with side="both",
	 * both harnesses are resumed; if both are paused and you resume only
	 * one, the session stays in status="paused" until the other also resumes.
	 */
	async resume(
		id: string,
		side: "direct" | "scramjet" | "both" = "scramjet"
	): Promise<boolean> {
		const s = this.map.get(id);
		if (!s) return false;
		if (s.status !== "paused") return false;
		if (!s.controls) return false;

		const toResume: Array<"direct" | "scramjet"> =
			side === "both"
				? (["direct", "scramjet"] as const).filter((sd) => !!s.pauses?.[sd])
				: s.pauses?.[side]
					? [side]
					: [];
		if (toResume.length === 0) return false;

		for (const sd of toResume) {
			if (s.pauses) delete s.pauses[sd];
			this.emit("event", {
				type: "resumed",
				id,
				side: sd,
			} satisfies SessionEvent);
			if (sd === "scramjet") await s.controls.resumeScramjet();
			else await s.controls.resumeDirect();
		}
		// If no pauses remain, flip back to running. Otherwise stay paused.
		if (!s.pauses || (!s.pauses.direct && !s.pauses.scramjet)) {
			s.status = "running";
			s.pauses = undefined;
		}
		this.emitState(s);
		return true;
	}

	/** Mark a session as canceling; currently a best-effort hint. */
	async cancel(id: string): Promise<boolean> {
		const s = this.map.get(id);
		if (!s) return false;
		if (s.status === "completed" || s.status === "errored") return false;
		s.canceling = true;
		// If paused, resume all sides so the driver loop can exit.
		if (s.status === "paused" && s.controls) {
			await s.controls.resumeScramjet().catch(() => {});
			await s.controls.resumeDirect().catch(() => {});
		}
		return true;
	}

	// ---------- runners ----------

	private async runRecord(
		s: SessionInternal,
		args: { target: string; headless?: boolean }
	) {
		this.begin(s);
		const outPath = resolve(
			join(this.tracesDir, defaultTraceName(args.target))
		);
		const direct = await withDriver(
			{
				headless: args.headless ?? true,
				log: (line) => this.pushLog(s, line),
				sides: "direct",
				nd: { direct: { mode: "record" } },
			},
			async (run, controls) => {
				s.controls = controls;
				const out = await run(args.target);
				if (!out.direct) throw new Error("record: direct run returned nothing");
				return out.direct;
			}
		);
		const trace: RecordedTrace = {
			version: 1,
			target: args.target,
			recordedAt: new Date().toISOString(),
			direct,
		};
		await writeFile(outPath, JSON.stringify(trace, null, 2), "utf-8");
		s.tracePath = outPath;

		const ndTotal = Object.values(direct.ndCaptures ?? {}).reduce(
			(a, v) => a + v.length,
			0
		);
		const ndApis = Object.keys(direct.ndCaptures ?? {}).length;
		s.ndSummary = { totalCaptures: ndTotal, apiPaths: ndApis };

		this.pushLog(s, `recorded → ${outPath}`);
		this.pushLog(
			s,
			`  events: ${countEvents(direct)}, nd captures: ${ndTotal} across ${ndApis} api paths`
		);
		this.finish(s);
	}

	private async runReplay(
		s: SessionInternal,
		args: {
			tracePath: string;
			headless?: boolean;
			breakpoint?: SessionBreakpoint;
		}
	) {
		this.begin(s);

		const raw = await readFile(args.tracePath, "utf-8");
		const trace = JSON.parse(raw) as RecordedTrace;
		if (trace.version !== 1)
			throw new Error(`unsupported trace version: ${trace.version}`);
		s.target = trace.target;
		this.pushLog(
			s,
			`loaded trace for ${trace.target} (recorded ${trace.recordedAt})`
		);

		const captures = capturesForReplay(trace.direct);
		const capTotal = Object.values(captures).reduce((a, v) => a + v.length, 0);
		this.pushLog(
			s,
			`  seeding ${capTotal} nd captures across ${Object.keys(captures).length} api paths`
		);

		// When alsoDirect is true, we also run the direct harness live so the
		// user can halt both windows at the same logical call. This means the
		// diff compares live-direct vs replay-scramjet (rather than recorded
		// direct vs replay-scramjet). For a breakpoint inspection workflow
		// that's the right call — the user wants to see both pages state-of-
		// the-world at the halt point, not compare against a stale recording.
		const alsoDirect = !!args.breakpoint?.alsoDirect;
		if (alsoDirect)
			this.pushLog(
				s,
				"  alsoDirect: running a live direct window that will pause at the same breakpoint"
			);

		const report = await withDriver(
			{
				headless: args.headless ?? true,
				log: (line) => this.pushLog(s, line),
				sides: alsoDirect ? "both" : "scramjet",
				nd: { scramjet: { mode: "replay", captures } },
				breakpoint: args.breakpoint
					? {
							api: args.breakpoint.api,
							op: args.breakpoint.op,
							matchIndex: args.breakpoint.matchIndex,
						}
					: undefined,
				applyBreakpointToDirect: alsoDirect,
				onPaused: (side, ev) => {
					const pause: PauseInfo = {
						at: new Date().toISOString(),
						reason: "breakpoint",
						side,
						raw: ev,
					};
					s.status = "paused";
					s.pauses = s.pauses ?? {};
					s.pauses[side] = pause;
					this.emit("event", {
						type: "paused",
						id: s.id,
						side,
						pause,
					} satisfies SessionEvent);
					this.emitState(s);
				},
			},
			async (run, controls) => {
				s.controls = controls;
				const { direct, scramjet } = await run(trace.target);
				if (!scramjet) throw new Error("replay: scramjet run returned nothing");
				this.pushLog(s, "diffing runs…");
				// For alsoDirect the live direct run supersedes the recorded one for the diff.
				const baseline = alsoDirect && direct ? direct : trace.direct;
				return diffRuns(trace.target, baseline, scramjet);
			}
		);
		s.report = report;
		s.facets = computeFacets(report.issues);
		this.finish(s);
	}

	private async runDiff(
		s: SessionInternal,
		args: { target: string; headless?: boolean }
	) {
		this.begin(s);
		const report = await withDriver(
			{
				headless: args.headless ?? true,
				log: (line) => this.pushLog(s, line),
				sides: "both",
			},
			async (run, controls) => {
				s.controls = controls;
				const { direct, scramjet } = await run(args.target);
				if (!direct || !scramjet) throw new Error("diff: need both sides");
				this.pushLog(s, "diffing runs…");
				return diffRuns(args.target, direct, scramjet);
			}
		);
		s.report = report;
		s.facets = computeFacets(report.issues);
		this.finish(s);
	}

	// ---------- helpers ----------

	private begin(s: SessionInternal) {
		s.status = "running";
		s.startedAt = new Date().toISOString();
		this.emitState(s);
	}

	private finish(s: SessionInternal) {
		s.status = "completed";
		s.completedAt = new Date().toISOString();
		this.emit("event", { type: "completed", id: s.id } satisfies SessionEvent);
		this.emitState(s);
	}

	private fail(s: SessionInternal, e: any) {
		s.status = "errored";
		s.error = e instanceof Error ? e.message : String(e);
		s.completedAt = new Date().toISOString();
		this.emit("event", {
			type: "error",
			id: s.id,
			message: s.error!,
		} satisfies SessionEvent);
		this.emitState(s);
	}

	private pushLog(s: SessionInternal, line: string) {
		s.log.push(line);
		if (s.log.length > MAX_LOG_LINES)
			s.log.splice(0, s.log.length - MAX_LOG_LINES);
		// A log line frequently doubles as a progress marker; cheap to forward both.
		s.progress = line;
		this.emit("event", {
			type: "log",
			id: s.id,
			line,
			at: new Date().toISOString(),
		} satisfies SessionEvent);
		this.emit("event", {
			type: "progress",
			id: s.id,
			progress: line,
		} satisfies SessionEvent);
	}

	private emitState(s: SessionInternal) {
		this.emit("event", {
			type: "state",
			session: toPublic(s),
		} satisfies SessionEvent);
	}
}

export function computeFacets(issues: DiffIssue[]): IssueFacets {
	const byKind: Record<string, number> = {};
	const byApiMap: Record<string, number> = {};
	for (const i of issues) {
		byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
		if (i.api) byApiMap[i.api] = (byApiMap[i.api] ?? 0) + 1;
	}
	const byApi = Object.entries(byApiMap)
		.map(([api, count]) => ({ api, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 50);
	return { total: issues.length, byKind, byApi };
}

function capturesForReplay(rec: RunArtifacts): Record<string, any[]> {
	const out: Record<string, any[]> = {};
	const src = rec.ndCaptures;
	if (!src) return out;
	for (const api of Object.keys(src)) {
		const arr = src[api];
		out[api] = arr.map((c: NDCapture) => c.data);
	}
	return out;
}

function defaultTraceName(url: string): string {
	let slug = url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_");
	if (slug.length > 80) slug = slug.slice(0, 80);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	return `${slug}.${ts}.trace.json`;
}

function countEvents(r: RunArtifacts): number {
	let n = 0;
	for (const k of Object.keys(r.traces)) n += r.traces[k].length;
	return n;
}
