#!/usr/bin/env node
/**
 * scramdiff CLI.
 *
 * Subcommands:
 *
 *   scramdiff <target-url> [--json] [--headed] [--out <path>]
 *       Live diff: spin up both harnesses, run direct + scramjet against the
 *       same URL sequentially, diff the resulting traces.
 *
 *   scramdiff record <target-url> [-o <path>] [--headed]
 *       Record a direct-only run with nondeterminism capture enabled. Saves
 *       the direct RunArtifacts (including ndCaptures for Math.random,
 *       Date.now, Performance.prototype.now, Performance.prototype.timeOrigin,
 *       Crypto.prototype.randomUUID, Crypto.prototype.getRandomValues) as a
 *       JSON file that replay can consume later.
 *
 *   scramdiff replay <trace-path> [--json] [--headed] [--out <path>]
 *       Load a recorded trace, run ONLY the scramjet harness, seeding its
 *       probe with the recorded ndCaptures so every site-originated call to
 *       a tracked ND source returns the same value direct saw. Diff the
 *       resulting scramjet trace against the recorded direct trace.
 *
 * Scramdiff owns its own scramjet runtime — there's no external-harness
 * option, because relying on a process we don't control is the opposite of
 * what a deterministic oracle should do. The driver spins up an internal
 * scramjet harness (HTTP + wisp on random loopback ports) on startup and
 * tears it down at the end.
 *
 * Exit codes: 0 = no divergences, 1 = issues found, 2 = fatal driver error.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withDriver } from "./driver/index.ts";
import { diffRuns } from "./diff/diff.ts";
import { formatReport } from "./diff/report.ts";
import type { NDCapture, RecordedTrace, RunArtifacts } from "./trace.ts";
import { startGuiServer } from "./gui/server.ts";

type Subcommand = "diff" | "record" | "replay" | "serve";

type CliArgs = {
	cmd: Subcommand;
	/** For diff/record: the URL. For replay: unused (URL comes from the trace). */
	target?: string;
	/** For replay: path to the recorded trace. */
	tracePath?: string;
	headed: boolean;
	json: boolean;
	outPath?: string;
	/** For serve: TCP port. */
	port?: number;
	/** For serve: directory to persist traces into. */
	tracesDir?: string;
};

function parseArgs(argv: string[]): CliArgs {
	const out: CliArgs = {
		cmd: "diff",
		headed: process.env.HEADED === "1" || process.env.HEADED === "true",
		json: false,
	};

	// Peek the first positional. If it matches a subcommand, consume it and
	// treat the remainder as that subcommand's args; otherwise this is the
	// default diff form where positional 0 is the target URL.
	let i = 0;
	const first = argv[0];
	if (first === "record") {
		out.cmd = "record";
		i = 1;
	} else if (first === "replay") {
		out.cmd = "replay";
		i = 1;
	} else if (first === "diff") {
		out.cmd = "diff";
		i = 1;
	} else if (first === "serve") {
		out.cmd = "serve";
		i = 1;
	}
	// else: default "diff", i stays at 0

	for (; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--headed") out.headed = true;
		else if (a === "--headless") out.headed = false;
		else if (a === "--json") out.json = true;
		else if (a === "--out" || a === "-o") out.outPath = argv[++i];
		else if (a === "--port" || a === "-p")
			out.port = Number.parseInt(argv[++i] ?? "", 10);
		else if (a === "--traces-dir") out.tracesDir = argv[++i];
		else if (a === "-h" || a === "--help") usage();
		else if (!a.startsWith("--") && !/^-[a-z]/i.test(a)) {
			if (out.cmd === "replay") {
				if (!out.tracePath) out.tracePath = a;
				else {
					console.error(`unexpected arg: ${a}`);
					usage();
				}
			} else {
				if (!out.target) out.target = a;
				else {
					console.error(`unexpected arg: ${a}`);
					usage();
				}
			}
		} else {
			console.error(`unknown arg: ${a}`);
			usage();
		}
	}
	return out;
}

function usage(): never {
	console.error(`scramdiff — differential oracle for scramjet

Usage:
  scramdiff <target-url>                    Live diff: direct + scramjet runs.
  scramdiff record <target-url> -o PATH     Record direct run + ND captures.
  scramdiff replay <trace-path>             Replay scramjet run against recorded trace.
  scramdiff serve [--port 3737]             Start GUI server for interactive sessions.

Common options:
  --headed         run Chromium with a visible window (also: HEADED=1 env var)
  --headless       force headless (overrides HEADED env)
  --json           emit the full report as JSON (diff/replay only)
  --out, -o PATH   write output to PATH instead of stdout (record: trace file;
                   diff/replay: report)
  --port, -p PORT  GUI server port (serve only; default 3737)
  --traces-dir DIR directory to persist traces in (serve only; default ./scramdiff-traces)
  -h, --help       show this help

Examples:
  scramdiff https://example.com
  scramdiff https://example.com --headed
  scramdiff record https://example.com -o example.trace.json
  scramdiff replay example.trace.json --json
  scramdiff serve --port 3737
`);
	process.exit(2);
}

/** Default trace filename derived from a URL. */
function defaultTracePath(url: string): string {
	let slug = url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_");
	if (slug.length > 80) slug = slug.slice(0, 80);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	return `./${slug}.${ts}.trace.json`;
}

/** Strip events keyed to one side's ndCaptures into the form the probe's
 *  replay layer expects: `Record<string, any[]>` of per-api data blobs. */
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

async function cmdDiff(args: CliArgs, progress: (s: string) => void) {
	if (!args.target) {
		console.error("missing target URL");
		usage();
	}
	const report = await withDriver(
		{ headless: !args.headed, log: progress, sides: "both" },
		async (run) => {
			const { direct, scramjet } = await run(args.target!);
			if (!direct || !scramjet) throw new Error("diff requires both sides");
			progress("diffing runs…");
			return diffRuns(args.target!, direct, scramjet);
		}
	);
	await emitReport(args, report, progress);
	process.exit(report.issues.length > 0 ? 1 : 0);
}

async function cmdRecord(args: CliArgs, progress: (s: string) => void) {
	if (!args.target) {
		console.error("missing target URL");
		usage();
	}
	const outPath = args.outPath ?? defaultTracePath(args.target!);
	const direct = await withDriver(
		{
			headless: !args.headed,
			log: progress,
			sides: "direct",
			nd: { direct: { mode: "record" } },
		},
		async (run) => {
			const out = await run(args.target!);
			if (!out.direct) throw new Error("record: direct run returned nothing");
			return out.direct;
		}
	);

	const trace: RecordedTrace = {
		version: 1,
		target: args.target!,
		recordedAt: new Date().toISOString(),
		direct,
	};
	await writeFile(outPath, JSON.stringify(trace, null, 2), "utf-8");

	const ndTotal = Object.values(direct.ndCaptures ?? {}).reduce(
		(a, v) => a + v.length,
		0
	);
	const ndApis = Object.keys(direct.ndCaptures ?? {}).length;
	progress(`recorded → ${outPath}`);
	progress(
		`  events: ${countEvents(direct)}, nd captures: ${ndTotal} across ${ndApis} api paths`
	);
	process.exit(0);
}

async function cmdReplay(args: CliArgs, progress: (s: string) => void) {
	if (!args.tracePath) {
		console.error("missing trace path");
		usage();
	}
	const raw = await readFile(args.tracePath!, "utf-8");
	const trace = JSON.parse(raw) as RecordedTrace;
	if (trace.version !== 1) {
		console.error(`unsupported trace version: ${trace.version}`);
		process.exit(2);
	}
	progress(`loaded trace for ${trace.target} (recorded ${trace.recordedAt})`);
	const captures = capturesForReplay(trace.direct);
	const capTotal = Object.values(captures).reduce((a, v) => a + v.length, 0);
	progress(
		`  seeding ${capTotal} nd captures across ${Object.keys(captures).length} api paths`
	);

	const report = await withDriver(
		{
			headless: !args.headed,
			log: progress,
			sides: "scramjet",
			nd: { scramjet: { mode: "replay", captures } },
		},
		async (run) => {
			const { scramjet } = await run(trace.target);
			if (!scramjet) throw new Error("replay: scramjet run returned nothing");
			progress("diffing runs…");
			return diffRuns(trace.target, trace.direct, scramjet);
		}
	);
	await emitReport(args, report, progress);
	process.exit(report.issues.length > 0 ? 1 : 0);
}

function countEvents(r: RunArtifacts): number {
	let n = 0;
	for (const k of Object.keys(r.traces)) n += r.traces[k].length;
	return n;
}

async function emitReport(
	args: CliArgs,
	report: any,
	progress: (s: string) => void
) {
	if (args.json) {
		const payload = JSON.stringify(report, null, 2);
		if (args.outPath) {
			await writeFile(args.outPath, payload, "utf-8");
			progress(`wrote json report → ${args.outPath}`);
		} else {
			process.stdout.write(payload + "\n");
		}
	} else {
		const text = formatReport(report);
		if (args.outPath) {
			await writeFile(args.outPath, text, "utf-8");
			progress(`wrote text report → ${args.outPath}`);
		} else {
			process.stdout.write(text + "\n");
		}
	}
}

async function cmdServe(args: CliArgs, progress: (s: string) => void) {
	const port = Number.isFinite(args.port) ? (args.port as number) : 3737;
	const tracesDir = resolve(args.tracesDir ?? "./scramdiff-traces");
	progress(`starting GUI server on :${port} (traces → ${tracesDir})…`);
	const { url } = await startGuiServer({
		port,
		tracesDir,
		headed: args.headed,
	});
	progress(`GUI ready at ${url}`);
	// Don't exit — Express keeps the event loop alive.
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const progress = (line: string) =>
		process.stderr.write(`[scramdiff] ${line}\n`);
	if (args.cmd === "record") return cmdRecord(args, progress);
	if (args.cmd === "replay") return cmdReplay(args, progress);
	if (args.cmd === "serve") return cmdServe(args, progress);
	return cmdDiff(args, progress);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(2);
});
