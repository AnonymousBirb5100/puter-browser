/**
 * Per-harness Playwright page setup.
 *
 * One harness = one BrowserContext + one Page configured to:
 *   - Install the scramdiff probe as an initial script in every frame.
 *   - Expose a CDP binding `__scramdiffEmit` that the probe calls with JSON
 *     trace events; this driver buffers them into the RunArtifacts.
 *   - Capture page errors and console messages for the report.
 *   - Drive a navigation, wait for the probe's "installed" heartbeat, then
 *     wait for the page to quiesce (virtual time drains).
 *
 * The scramjet harness additionally injects scramjet's runtime via the
 * existing scramjet bundle, so URLs passed to navigate() go through
 * `window.__scramdiffProxyRewrite(url)` to become proxy URLs before goto().
 */

import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { buildProbeScript, type ProbeConfig } from "../probe/probe.ts";
import {
	applyDeterminismToSession,
	rearmVirtualTime,
	type DeterminismOptions,
} from "./determinism.ts";
import type {
	CoverageSample,
	Harness,
	RunArtifacts,
	TraceEvent,
} from "../trace.ts";

export type HarnessOptions = {
	browser: Browser;
	harness: Harness;
	determinism: DeterminismOptions;
	probeConfig: Omit<ProbeConfig, "harness">;
	/**
	 * Enable CDP Debugger domain so `debugger;` statements in the probe
	 * actually halt page execution. Set this when probeConfig.breakpoint is
	 * configured. Defaults to false — unconditionally enabling CDP Debugger
	 * on every run introduces overhead and debugger-protocol chatter.
	 */
	enableDebugger?: boolean;
	/**
	 * Called on every Debugger.paused event (fires synchronously when the
	 * probe hits a breakpoint's `debugger;` statement). Receives the raw
	 * paused event for optional inspection; call resume() on the returned
	 * HarnessRun to continue execution.
	 */
	onPaused?: (ev: any) => void;
	/** Called before each run; last chance to install per-run fixtures. */
	beforeNavigate?: (page: Page) => Promise<void>;
	/**
	 * Responsible for getting the target content loaded so the probe can
	 * observe it. Receives the Page and the target URL; returns the URL the
	 * target ended up at (for reporting). Whatever it does — top-level
	 * page.goto for the direct harness, iframe navigation via scramjet's
	 * controller for the scramjet harness — the run() method below waits for
	 * it to resolve, then lets virtual time drain.
	 *
	 * Any events the probe emits during bootstrap/setup phases are discarded
	 * by run() (see the second blankArtifacts below).
	 */
	loadTarget: (url: string, ctx: { page: Page }) => Promise<string>;
};

export type HarnessRun = {
	run(targetUrl: string): Promise<RunArtifacts>;
	/**
	 * If the page is currently paused at a `debugger;` (probe breakpoint),
	 * resume execution so `run()` can complete. No-op if not paused, or if
	 * Debugger is not enabled. Safe to call multiple times.
	 */
	resume(): Promise<void>;
	/** True iff the probe currently has the page halted at a breakpoint. */
	isPaused(): boolean;
	close(): Promise<void>;
};

export async function createHarness(opts: HarnessOptions): Promise<HarnessRun> {
	const context: BrowserContext = await opts.browser.newContext({
		ignoreHTTPSErrors: true,
		viewport: { width: 1280, height: 800 },
		deviceScaleFactor: 1,
		// Stable UA so the page can't branch on it differently across runs.
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 scramdiff",
	});

	const page = await context.newPage();

	// Trace collection state. Populated by the binding and console/error hooks.
	let artifacts: RunArtifacts = blankArtifacts(opts.harness);

	const probeSrc = buildProbeScript({
		harness: opts.harness,
		runId: opts.probeConfig.runId,
		maxEventsPerTask: opts.probeConfig.maxEventsPerTask,
		trackDataProperties: opts.probeConfig.trackDataProperties,
		ndMode: opts.probeConfig.ndMode,
		ndCaptures: opts.probeConfig.ndCaptures,
		breakpoint: opts.probeConfig.breakpoint,
	});

	// Inject the probe into every document (main + all subframes). Playwright's
	// addInitScript runs before any page script; the probe then defers its
	// actual wrapping until scramjet finishes installing (scramjet run only).
	await context.addInitScript(probeSrc);

	// CDP binding for trace emission. We use Runtime.addBinding rather than
	// Playwright's exposeBinding because we want one global function per realm
	// with JSON-string payloads and no promise plumbing.
	const cdp = await context.newCDPSession(page);
	await applyDeterminismToSession(cdp, opts.determinism);
	await cdp.send("Runtime.addBinding", { name: "__scramdiffEmit" });

	// Pause state (breakpoint support). Populated when the Debugger domain is
	// enabled and the probe hits a `debugger;` statement.
	let paused = false;
	let lastPausedEvent: any = null;
	if (opts.enableDebugger) {
		// The "Loading…" stall the user sees when clicking deeper into the
		// paused call stack happens because V8 discards the source text from
		// its Script objects after compile (bytecode flush / streaming-compile
		// source drop), and DevTools' `Debugger.getScriptSource` then falls
		// through to a Blink ResourceFetcher re-fetch, whose completion needs
		// the renderer main thread — which is sitting in V8's paused inspector
		// loop and only drains CDP messages, not Mojo IPC. The re-fetch sits
		// queued until resume.
		//
		// Fixes applied:
		//   - bump the inspector's script cache to 1GB so our session's
		//     retained-source entries never evict (helps any fallback path
		//     that walks session cache),
		//   - Debugger.setAsyncCallStackDepth so the user can walk async
		//     boundaries without each async frame re-requesting source,
		//   - launch flags in determinism.ts keep V8 from discarding source
		//     post-compile (process-level, applies to every script V8 sees),
		//   - eager Debugger.getScriptSource on every scriptParsed (below): our
		//     session asks V8 for the source the moment a script compiles,
		//     which forces V8 to hold the materialized source string. The same
		//     underlying V8 Script is what DevTools' session later queries —
		//     so DevTools inspector hits the already-materialized source
		//     instead of going through a fallback fetch path.
		await cdp.send("Debugger.enable", { maxScriptsCacheSize: 1_000_000_000 });
		await cdp
			.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 })
			.catch(() => {});
		// Don't break on any of the probe's internal exceptions or the site's
		// own uncaught errors — only `debugger;` statements should halt.
		await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });

		// Eager source materialization. On every script parse, ask V8 for its
		// source. The return value is discarded — we only care about the side
		// effect of pinning it live in V8's (and Blink's ScriptResource's)
		// hot memory. This runs before any `debugger;` pause, so when DevTools
		// later queries the same script, the source is ready-to-serve.
		//
		// Track which scriptIds we've fetched so we can re-fetch any we missed
		// at pause-time. Some scripts (eval, internal) can parse so close to a
		// `debugger;` hit that the scriptParsed listener's async fetch hasn't
		// completed before Chromium enters the paused inspector loop.
		const materialized = new Set<string>();
		cdp.on("Debugger.scriptParsed", (ev: any) => {
			if (!ev.scriptId) return;
			cdp
				.send("Debugger.getScriptSource", { scriptId: ev.scriptId })
				.then(() => {
					materialized.add(ev.scriptId);
				})
				.catch(() => {});
		});

		cdp.on("Debugger.paused", async (ev: any) => {
			paused = true;
			lastPausedEvent = ev;
			// Before handing control to the caller (which will ultimately let
			// the user click stack frames in DevTools), ensure every script
			// referenced on the call stack has its source materialized in V8.
			// From this session's perspective `getScriptSource` runs inside
			// V8's paused inspector message loop — CDP drains, Blink Mojo IPC
			// does not — so a fetch that misses here would block. But because
			// the --no-flush-bytecode launch flag keeps V8 Script.source alive
			// post-compile, V8 can serve us directly without needing Blink's
			// ResourceFetcher to re-fetch. That's the whole point of the flag.
			try {
				const ids = new Set<string>();
				for (const f of (ev.callFrames ?? []) as any[]) {
					const sid = f?.location?.scriptId;
					if (sid && !materialized.has(sid)) ids.add(sid);
				}
				for (const sid of ids) {
					try {
						await cdp.send("Debugger.getScriptSource", { scriptId: sid });
						materialized.add(sid);
					} catch {}
				}
			} catch {}
			if (opts.onPaused) {
				try {
					opts.onPaused(ev);
				} catch {}
			}
		});
		cdp.on("Debugger.resumed", () => {
			paused = false;
			lastPausedEvent = null;
		});
	}

	cdp.on("Runtime.bindingCalled", (event) => {
		if (event.name !== "__scramdiffEmit") return;
		try {
			const ev = JSON.parse(event.payload) as TraceEvent;
			// ND record events: decoded payload goes into artifacts.ndCaptures, not traces.
			if (ev.api === "__scramdiff.nd.record") {
				const apiArg = ev.args?.[0] as any;
				const dataArg = ev.args?.[1] as any;
				if (apiArg?.t === "string" && dataArg?.t === "string") {
					const apiPath = apiArg.v as string;
					let data: any;
					try {
						data = JSON.parse(dataArg.v as string);
					} catch {
						data = null;
					}
					if (data !== null) {
						const captures = (artifacts.ndCaptures ??= {});
						(captures[apiPath] ??= []).push({ api: apiPath, data });
					}
				}
				return;
			}
			// ND desync events: surfaced in the artifacts for post-run attribution.
			// Keep them in the trace bucket under an internal key so the CLI can
			// display them, but mark internal so they don't enter the diff.
			if (ev.api === "__scramdiff.nd.desync") {
				ev.internal = true;
			}
			const oid = ev.origin ? `${ev.origin.kind}:${ev.origin.id}` : "unknown";
			const bucket = (artifacts.traces[oid] ??= []);
			bucket.push(ev);
			if (
				ev.api === "__scramdiff.installed" &&
				artifacts.probeInstalledAt === null
			) {
				artifacts.probeInstalledAt = ev.vtime;
			}
		} catch (e) {
			// Swallow individual parse failures; they're usually probe-side serialization edge cases.
		}
	});

	page.on("console", (msg) => {
		artifacts.console.push({
			level: msg.type(),
			text: msg.text(),
			vtime: 0, // driver-side vtime unknown without another CDP roundtrip
		});
	});

	page.on("pageerror", (err) => {
		artifacts.errors.push({
			message: err.message,
			stack: err.stack,
			vtime: 0,
		});
	});

	return {
		async run(targetUrl: string) {
			// Blank the artifacts so setup-phase events (the scramjet harness
			// bootstrap initializing its SW/Controller, or leftovers from a
			// prior run on this harness) don't pollute the instrumented run.
			artifacts = blankArtifacts(opts.harness);
			artifacts.vtimeStart = 0;

			if (opts.beforeNavigate) await opts.beforeNavigate(page);
			await rearmVirtualTime(cdp, opts.determinism);

			// Delegate the actual loading to the harness-specific loader.
			// For direct: page.goto(target).
			// For scramjet: page stays on bootstrap (URL-filtered in the probe
			//   so no events emit there), and the target is loaded into the
			//   bootstrap's registered iframe via frame.go(url). Events from
			//   the iframe's target document ARE the events we want to record —
			//   do not blank artifacts after this returns.
			let finalUrl = targetUrl;
			try {
				finalUrl = await opts.loadTarget(targetUrl, { page });
			} catch (e) {
				// loadTarget failures are driver-side — don't pollute pageerror.
				// eslint-disable-next-line no-console
				console.error(
					`[${opts.harness}] loadTarget failed:`,
					(e as Error).message
				);
			}
			artifacts.finalUrl = finalUrl;

			// Let the virtual clock drain remaining microtasks/timeouts. The
			// "pauseIfNetworkFetchesPending" policy advances vtime only when
			// network is idle, so this eventually stabilizes.
			try {
				await page.waitForLoadState("networkidle", { timeout: 15_000 });
			} catch {
				// Some pages never reach networkidle (long-poll, SSE). That's fine.
			}

			// Collect precise coverage right before we finalize the run.
			try {
				const cov = await cdp.send("Profiler.takePreciseCoverage");
				artifacts.coverage = (cov.result as any).map(
					(entry: any): CoverageSample => ({
						url: entry.url,
						functions: entry.functions,
					})
				);
			} catch {
				// Coverage sometimes throws on redirect-heavy pages; non-fatal.
			}

			artifacts.vtimeEnd = artifacts.probeInstalledAt ?? 0;
			return artifacts;
		},
		async resume() {
			if (!opts.enableDebugger) return;
			if (!paused) return;
			// Debugger.resume lets the page continue past `debugger;` until the
			// next break. If the probe has further breakpoint hits queued, we'll
			// see another Debugger.paused.
			await cdp.send("Debugger.resume").catch(() => {});
			// cdp.on("Debugger.resumed") will clear `paused`.
		},
		isPaused() {
			return paused;
		},
		async close() {
			// If we're sitting on a debugger; statement when close() is called,
			// resume so the page can tear down. Without this the detach/close
			// can hang waiting for the render process to reach a safe point.
			if (opts.enableDebugger && paused) {
				await cdp.send("Debugger.resume").catch(() => {});
			}
			await cdp.detach().catch(() => {});
			await page.close().catch(() => {});
			await context.close().catch(() => {});
		},
	};
}

function blankArtifacts(harness: Harness): RunArtifacts {
	return {
		harness,
		vtimeStart: 0,
		vtimeEnd: 0,
		traces: {},
		coverage: [],
		console: [],
		errors: [],
		finalUrl: "",
		probeInstalledAt: null,
	};
}
