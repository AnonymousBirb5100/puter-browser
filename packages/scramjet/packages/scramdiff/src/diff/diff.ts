/**
 * Diff engine.
 *
 * Input: RunArtifacts from direct + scramjet runs.
 * Output: DiffReport listing every divergence, attributed where possible.
 *
 * The comparison is strict and literal — the page observed post values, and
 * if scramjet's post differs from direct's post for the same logical call,
 * that's the bug. No rewriting, no heuristic normalization of the observed
 * string: a proxy URL leaking into an API return value IS the divergence.
 *
 * Matching strategy (per origin):
 *   1. Group both runs' events by taskId, preserving within-task order.
 *   2. Pair tasks by (taskId, first-event API+args fingerprint). We don't
 *      require positional equality between runs — benign async reordering
 *      (two independent fetches completing in different orders under virtual
 *      time) shouldn't cascade into spurious event-level divergences.
 *   3. Within matched tasks, walk events in order and compare by
 *      (api, op, args). The first value divergence attributes to the event.
 *   4. Unmatched tasks: report as missing/extra work — a sign scramjet
 *      caused the site to schedule different work.
 *
 * Attribution:
 *   - For value divergences, include recent matched events whose post
 *     differed so the human triaging sees the chain of suspicion.
 *   - If precise coverage is available, find the script+function whose
 *     branch coverage diverges; that's the control-flow fork that user-visibly
 *     broke the site.
 */

import type {
	CoverageSample,
	DiffIssue,
	DiffReport,
	RunArtifacts,
	TraceEvent,
	TraceValue,
} from "../trace.ts";
import { canonicalizeRun, originsEqual, valuesEqual } from "./canonicalize.ts";

function argsEqual(a?: TraceValue[], b?: TraceValue[]): boolean {
	const la = a ? a.length : 0;
	const lb = b ? b.length : 0;
	if (la !== lb) return false;
	for (let i = 0; i < la; i++) {
		if (!valuesEqual(a![i], b![i])) return false;
	}
	return true;
}

/** Fingerprint for matching events within a task. Intentionally ignores post so divergences surface. */
function eventFingerprint(ev: TraceEvent): string {
	const args = ev.args ? ev.args.map(fprintValue).join("|") : "";
	const self = ev.self ? fprintValue(ev.self) : "";
	return `${ev.api}::${ev.op}::${self}::${args}`;
}

function fprintValue(v: TraceValue): string {
	switch (v.t) {
		case "undefined":
			return "u";
		case "primitive":
			return "p:" + String((v as any).v);
		case "string":
			return "s:" + (v as any).v;
		case "bigint":
			return "b:" + (v as any).v;
		case "symbol":
			return "y:" + (v as any).v;
		case "function":
			return `f:${v.name}/${v.length}`;
		case "object":
		case "array":
			return `${v.t === "array" ? "a" : "o"}:${(v as any).ctor}:${(v as any).hash || (v as any).summary}`;
		case "dom":
			return `d:${v.ctor}:${v.desc}`;
		case "error":
			return `e:${v.name}:${v.message}`;
		case "unserializable":
			return `x:${v.reason}`;
	}
}

type TaskGroup = {
	taskId: string;
	events: TraceEvent[];
};

function groupByTask(events: TraceEvent[]): TaskGroup[] {
	const map = new Map<string, TaskGroup>();
	for (const ev of events) {
		if (ev.internal) continue;
		let g = map.get(ev.taskId);
		if (!g) {
			g = { taskId: ev.taskId, events: [] };
			map.set(ev.taskId, g);
		}
		g.events.push(ev);
	}
	// Preserve insertion order but also sort each task's events by taskSeq for safety.
	const groups: TaskGroup[] = [];
	for (const g of map.values()) {
		g.events.sort((a, b) => a.taskSeq - b.taskSeq);
		groups.push(g);
	}
	return groups;
}

/**
 * Given two task-grouped streams, produce matched and unmatched task pairs.
 * A task matches if its (first-event fingerprint, taskId) hashes equal. This
 * handles the common case where scheduling lineage produces identical taskIds;
 * when that fails, we try fingerprint-only matching as a fallback so we can
 * still diff at the event level.
 */
function matchTasks(
	a: TaskGroup[],
	b: TaskGroup[]
): {
	matched: Array<[TaskGroup, TaskGroup]>;
	aOnly: TaskGroup[];
	bOnly: TaskGroup[];
} {
	const bByTaskId = new Map<string, TaskGroup>();
	const bByFirstFp = new Map<string, TaskGroup[]>();
	for (const g of b) {
		bByTaskId.set(g.taskId, g);
		if (g.events[0]) {
			const fp = eventFingerprint(g.events[0]);
			(bByFirstFp.get(fp) ?? bByFirstFp.set(fp, []).get(fp)!).push(g);
		}
	}

	const matched: Array<[TaskGroup, TaskGroup]> = [];
	const aOnly: TaskGroup[] = [];
	const consumed = new Set<TaskGroup>();

	for (const ga of a) {
		let gb = bByTaskId.get(ga.taskId);
		if (gb && consumed.has(gb)) gb = undefined;
		if (!gb && ga.events[0]) {
			const list = bByFirstFp.get(eventFingerprint(ga.events[0]));
			if (list) {
				gb = list.find((g) => !consumed.has(g));
			}
		}
		if (gb) {
			matched.push([ga, gb]);
			consumed.add(gb);
		} else {
			aOnly.push(ga);
		}
	}
	const bOnly = b.filter((g) => !consumed.has(g));
	return { matched, aOnly, bOnly };
}

/**
 * Diff a single matched task pair. Walks events in order; emits a value-divergence
 * issue for every (api, op, args)-matched pair whose post differs, and
 * missing/extra-call issues for events that don't line up.
 */
function diffTask(
	direct: TraceGroup,
	scramjet: TraceGroup,
	issues: DiffIssue[],
	suspects: Map<
		string,
		Array<{ api: string; directPost: TraceValue; scramjetPost: TraceValue }>
	>
) {
	let i = 0,
		j = 0;
	const ad = direct.events;
	const sc = scramjet.events;

	while (i < ad.length && j < sc.length) {
		const da = ad[i];
		const sa = sc[j];

		const fd = eventFingerprint(da);
		const fs = eventFingerprint(sa);

		if (fd === fs) {
			// Matched event: compare post.
			if (!valuesEqual(da.post, sa.post)) {
				const suspect = {
					api: da.api,
					directPost: da.post,
					scramjetPost: sa.post,
				};
				(
					suspects.get(direct.taskId) ??
					suspects.set(direct.taskId, []).get(direct.taskId)!
				).push(suspect);
				issues.push({
					kind:
						sa.pre && valuesEqual(sa.pre, sa.post)
							? "missing-interceptor"
							: "value-divergence",
					api: da.api,
					message:
						`${da.api} ${da.op}: direct returned ${fprintValue(da.post)}, scramjet returned ${fprintValue(sa.post)}` +
						(sa.pre
							? ` (scramjet's native pre-value was ${fprintValue(sa.pre)})`
							: ""),
					direct: da,
					scramjet: sa,
					attribution: {
						suspects: Array.from(suspects.get(direct.taskId) ?? [])
							.slice(-5)
							.reverse(),
					},
				});
			}
			i++;
			j++;
			continue;
		}

		// Fingerprints differ — one side called something the other didn't, or called
		// in a different order. Look ahead a small window to resync.
		const WINDOW = 8;
		let resyncD = -1,
			resyncS = -1;
		for (let k = 1; k <= WINDOW && resyncD === -1 && resyncS === -1; k++) {
			if (i + k < ad.length && eventFingerprint(ad[i + k]) === fs)
				resyncD = i + k;
			if (j + k < sc.length && eventFingerprint(sc[j + k]) === fd)
				resyncS = j + k;
		}
		if (resyncD !== -1) {
			// Scramjet is missing events ad[i..resyncD-1].
			for (let k = i; k < resyncD; k++) {
				issues.push({
					kind: "missing-call",
					api: ad[k].api,
					message: `${ad[k].api} ${ad[k].op}: direct called but scramjet did not`,
					direct: ad[k],
				});
			}
			i = resyncD;
		} else if (resyncS !== -1) {
			for (let k = j; k < resyncS; k++) {
				issues.push({
					kind: "extra-call",
					api: sc[k].api,
					message: `${sc[k].api} ${sc[k].op}: scramjet called but direct did not`,
					scramjet: sc[k],
				});
			}
			j = resyncS;
		} else {
			// No resync within window — emit both as missing/extra and advance both.
			issues.push({
				kind: "missing-call",
				api: da.api,
				message: `${da.api} ${da.op}: direct called but no matching scramjet call within window`,
				direct: da,
			});
			issues.push({
				kind: "extra-call",
				api: sa.api,
				message: `${sa.api} ${sa.op}: scramjet called with no matching direct call within window`,
				scramjet: sa,
			});
			i++;
			j++;
		}
	}
	while (i < ad.length) {
		issues.push({
			kind: "missing-call",
			api: ad[i].api,
			message: `${ad[i].api} ${ad[i].op}: direct called but scramjet did not`,
			direct: ad[i],
		});
		i++;
	}
	while (j < sc.length) {
		issues.push({
			kind: "extra-call",
			api: sc[j].api,
			message: `${sc[j].api} ${sc[j].op}: scramjet called but direct did not`,
			scramjet: sc[j],
		});
		j++;
	}
}

type TraceGroup = TaskGroup;

/**
 * URLs whose coverage is never a real signal:
 *   - scramdiff's own probe. Different call counts between harnesses are
 *     expected (flushPending runs more in scramjet because more events emit).
 *   - scramjet's own runtime (scramjet.js / controller.*.js). Only loads in
 *     the scramjet run; even when it loads in both it's just scramjet's own
 *     interceptor, not the site's code.
 *   - blob: URLs scramjet uses internally to shim subresource loads.
 */
function isNonUserScript(url: string): boolean {
	if (!url) return true;
	if (url === "scramdiff:probe") return true;
	if (url.indexOf("scramdiff:") === 0) return true;
	if (/\/(?:scramjet\/scramjet|controller\/controller)[^?\s)]*/.test(url))
		return true;
	return false;
}

/**
 * Coverage divergence: compare per-script function call counts. A function
 * that executed in one run but not the other is a control-flow fork — the
 * site took a different branch. This is the strongest user-visible failure
 * signal because it maps to "the site's JS did something different."
 */
function diffCoverage(
	direct: CoverageSample[],
	scramjet: CoverageSample[]
): DiffIssue[] {
	const dMap = new Map<string, CoverageSample>(direct.map((s) => [s.url, s]));
	const sMap = new Map<string, CoverageSample>(scramjet.map((s) => [s.url, s]));
	const issues: DiffIssue[] = [];
	const urls = new Set<string>([...dMap.keys(), ...sMap.keys()]);
	for (const url of urls) {
		if (isNonUserScript(url)) continue;
		const d = dMap.get(url);
		const s = sMap.get(url);
		if (!d || !s) continue; // scripts unique to one run are often scramjet's own shims — handled separately.
		const dFns = new Map(
			d.functions.map((f) => [
				f.functionName || `@${f.ranges[0]?.startOffset ?? 0}`,
				f,
			])
		);
		const sFns = new Map(
			s.functions.map((f) => [
				f.functionName || `@${f.ranges[0]?.startOffset ?? 0}`,
				f,
			])
		);
		for (const [name, df] of dFns) {
			const sf = sFns.get(name);
			if (!sf) continue;
			// Compare total invocation count. For block coverage, the sum of per-range
			// counts is the number of times that block executed.
			const dCount = df.ranges.reduce((a, r) => a + r.count, 0);
			const sCount = sf.ranges.reduce((a, r) => a + r.count, 0);
			if (dCount !== sCount) {
				issues.push({
					kind: "coverage-divergence",
					message: `${url}::${name} executed ${dCount}x direct vs ${sCount}x scramjet`,
					attribution: {
						coveragePoint: {
							url,
							functionName: name,
							offset: df.ranges[0]?.startOffset ?? 0,
						},
						suspects: [],
					},
				});
			}
		}
	}
	return issues;
}

/**
 * Normalize origin keys across harnesses. In the direct run, the target
 * document is the top-level window (origin key "window:top"). In the scramjet
 * run, the target document is an iframe INSIDE the harness bootstrap (origin
 * key "window:0" or similar frame-tree path) because scramjet only works when
 * its controller registers a specific frame. For the diff to match target-vs-
 * target across harnesses, we coalesce all window-kind origins into a single
 * canonical bucket per harness. Non-window origins (workers, service workers)
 * keep their original keys so they match strictly.
 *
 * This is safe for us because: the probe URL-filters the scramjet bootstrap
 * (no events emit there), so the iframe is the only window-kind origin on
 * the scramjet side. Direct only ever has the top-level window. Sites that
 * load their own subframes would produce multiple window-kind origins; until
 * we handle per-frame matching, coalescing sums their events under one bucket.
 */
function coalesceTraces(
	traces: Record<string, TraceEvent[]>
): Record<string, TraceEvent[]> {
	const out: Record<string, TraceEvent[]> = {};
	const windowEvents: TraceEvent[] = [];
	for (const [k, evs] of Object.entries(traces)) {
		if (k.startsWith("window:")) {
			for (const e of evs) windowEvents.push(e);
		} else {
			out[k] = evs;
		}
	}
	if (windowEvents.length > 0) {
		// Preserve runSeq order across merged frames.
		windowEvents.sort((a, b) => a.runSeq - b.runSeq);
		out["window:target"] = windowEvents;
	}
	return out;
}

export function diffRuns(
	target: string,
	direct: RunArtifacts,
	scramjet: RunArtifacts
): DiffReport {
	const issues: DiffIssue[] = [];

	const directTraces = coalesceTraces(direct.traces);
	const scramjetTraces = coalesceTraces(scramjet.traces);

	// Rewrite global-singleton object hashes (Window, Document, etc.) to
	// creation-order ordinals within each run's per-origin stream. After this,
	// "direct's first Window" and "scramjet's first Window" both hash to
	// ord:0 and compare equal; but if scramjet exposed a second Window when
	// direct returned its first, those map to different ordinals and the
	// divergence surfaces through the normal valuesEqual path.
	canonicalizeRun(directTraces);
	canonicalizeRun(scramjetTraces);

	// Event-level diff, per origin.
	const originKeys = new Set<string>([
		...Object.keys(directTraces),
		...Object.keys(scramjetTraces),
	]);

	let tasksMatched = 0,
		tasksUnmatched = 0;
	const suspects = new Map<
		string,
		Array<{ api: string; directPost: TraceValue; scramjetPost: TraceValue }>
	>();

	for (const oid of originKeys) {
		const dEvents = directTraces[oid] ?? [];
		const sEvents = scramjetTraces[oid] ?? [];

		// Skip origins that only one run produced events for — most commonly a
		// frame that exists in only one harness (e.g. scramjet's service worker
		// registration). We still flag a summary issue for visibility.
		if (dEvents.length === 0 || sEvents.length === 0) {
			if (dEvents.length === 0 && sEvents.length > 0) {
				issues.push({
					kind: "extra-call",
					message: `origin ${oid}: scramjet produced ${sEvents.length} events but direct produced none`,
				});
			} else if (sEvents.length === 0 && dEvents.length > 0) {
				issues.push({
					kind: "missing-call",
					message: `origin ${oid}: direct produced ${dEvents.length} events but scramjet produced none`,
				});
			}
			continue;
		}

		// Verify origin structural equality (kind + frame path).
		const dOrigin = dEvents[0]?.origin;
		const sOrigin = sEvents[0]?.origin;
		if (dOrigin && sOrigin && !originsEqual(dOrigin, sOrigin)) {
			issues.push({
				kind: "value-divergence",
				message: `origin mismatch for ${oid}: direct=${dOrigin.kind}/${dOrigin.id} vs scramjet=${sOrigin.kind}/${sOrigin.id}`,
			});
		}

		const dGroups = groupByTask(dEvents);
		const sGroups = groupByTask(sEvents);

		const { matched, aOnly, bOnly } = matchTasks(dGroups, sGroups);
		tasksMatched += matched.length;
		tasksUnmatched += aOnly.length + bOnly.length;

		for (const [da, sa] of matched) {
			diffTask(da, sa, issues, suspects);
		}
		for (const g of aOnly) {
			issues.push({
				kind: "missing-call",
				message: `task ${g.taskId} (${g.events.length} events) ran in direct but not in scramjet; first: ${g.events[0]?.api}`,
				direct: g.events[0],
			});
		}
		for (const g of bOnly) {
			issues.push({
				kind: "extra-call",
				message: `task ${g.taskId} (${g.events.length} events) ran in scramjet but not in direct; first: ${g.events[0]?.api}`,
				scramjet: g.events[0],
			});
		}
	}

	// Error divergence: if one run threw a page error the other didn't, that's
	// the canonical user-visible symptom of a scramjet failure.
	const dErrs = new Set(direct.errors.map((e) => e.message));
	const sErrs = new Set(scramjet.errors.map((e) => e.message));
	for (const m of sErrs) {
		if (!dErrs.has(m)) {
			issues.push({
				kind: "error-divergence",
				message: `scramjet-only pageerror: ${m}`,
			});
		}
	}
	for (const m of dErrs) {
		if (!sErrs.has(m)) {
			issues.push({
				kind: "error-divergence",
				message: `direct-only pageerror: ${m}`,
			});
		}
	}

	// Coverage divergence — the strongest control-flow signal.
	const covIssues = diffCoverage(direct.coverage, scramjet.coverage);
	issues.push(...covIssues);

	const eventsDirect = Object.values(direct.traces).reduce(
		(a, arr) => a + arr.length,
		0
	);
	const eventsScramjet = Object.values(scramjet.traces).reduce(
		(a, arr) => a + arr.length,
		0
	);

	return {
		target,
		issues,
		summary: {
			eventsDirect,
			eventsScramjet,
			tasksMatched,
			tasksUnmatched,
			coverageDivergentScripts: new Set(
				covIssues.map((i) => i.attribution?.coveragePoint?.url).filter(Boolean)
			).size,
		},
	};
}
