/**
 * Determinism controls applied to every launched Chromium instance.
 *
 * These are the flags / CDP calls that remove the uncontrolled nondeterminism
 * the differ would otherwise confuse with real scramjet bugs:
 *
 *   --js-flags="--predictable --random-seed=N"
 *       V8 predictable mode: deterministic Math.random, deterministic iteration
 *       order for hash tables, disabled concurrent marking, fixed allocator.
 *
 *   --use-gl=swiftshader / --disable-accelerated-2d-canvas
 *       Software rasterizer; GPU drivers are not deterministic.
 *
 *   --deterministic-mode
 *       Chrome's own umbrella flag that turns on a bunch of testing
 *       primitives (fixed time origin, etc.). Where available.
 *
 *   --disable-field-trial-config, --disable-features=...
 *       No A/B'd Chrome features leaking into the run.
 *
 *   Emulation.setVirtualTimePolicy with mode "pauseIfNetworkFetchesPending"
 *       Time is frozen while tasks run and advances on idle; setTimeout and
 *       friends become deterministic w.r.t. task sequence, not wall clock.
 *
 * Not everything here is bulletproof — GPU, audio, crypto.getRandomValues,
 * and Date-injection into new realms still leak. Those get handled in the
 * probe via explicit overrides.
 */

import type { CDPSession } from "playwright";

export type DeterminismOptions = {
	randomSeed: number;
	virtualTimeBudgetMs: number;
	headless: boolean;
	/**
	 * Whether to enable CDP-level virtual time. In theory this gives us fully
	 * task-driven clocks (Date.now / performance.now / setTimeout). In practice
	 * `Emulation.setVirtualTimePolicy` + `pauseIfNetworkFetchesPending` can
	 * deadlock page.goto's `load` wait on loopback origins (the load event
	 * fires only when virtual time advances, which requires network idle,
	 * which we don't always get while SW registration is in flight). We leave
	 * it off by default and rely on timezone/locale/seed for reproducibility;
	 * the coverage and task-causal matching layers absorb the residual jitter.
	 */
	enableVirtualTime: boolean;
};

export const DETERMINISM_DEFAULTS: DeterminismOptions = {
	randomSeed: 0xdeadbeef,
	virtualTimeBudgetMs: 120_000,
	headless: true,
	enableVirtualTime: false,
};

export type ChromiumLaunchArgsExtras = {
	/**
	 * If true, Chromium launches with `--auto-open-devtools-for-tabs` so the
	 * DevTools panel attaches *before* the page's scripts parse. This matters
	 * for `debugger;` breakpoint workflows: a late-attached DevTools session
	 * has no retained inspector source cache for pre-existing scripts, and
	 * its first getScriptSource can fall through to a Blink ResourceFetcher
	 * re-fetch — which deadlocks against V8's paused inspector loop.
	 * Auto-opening gets DevTools' session subscribed to scriptParsed from the
	 * first frame.
	 */
	autoOpenDevtools?: boolean;
};

export function chromiumLaunchArgs(
	opts: DeterminismOptions,
	extras?: ChromiumLaunchArgsExtras
): string[] {
	// NOTE ON --predictable: V8's --predictable single-threaded mode buys us
	// reproducible Math.random and internal iteration order, but it is known to
	// crash Chromium's renderer process (Chromium is multi-threaded by design;
	// --predictable forces V8's main-isolate concurrency off, but the browser
	// process still expects worker threads). We keep the *random-seed* (which
	// is compatible) and drop --predictable for now. The coverage+task-causal
	// matching layers pick up enough of the slack to keep the oracle usable;
	// true V8-predictable determinism requires a patched Chromium build, which
	// is a known limitation documented in the README.
	//
	// NOTE ON --no-lazy / --no-flush-bytecode: these keep V8 from discarding
	// function source bytes after compile. Normally V8 lazy-parses inner
	// functions and, under memory pressure or its periodic bytecode-flush
	// heuristic, drops the source text from Script objects so
	// Debugger.getScriptSource has to fall through to a Blink ResourceFetcher
	// re-fetch. That re-fetch's completion callback runs on the renderer main
	// thread, which, when the probe has halted at a `debugger;` statement, is
	// sitting in V8's paused inspector message loop — a loop that drains CDP
	// but not Mojo IPC. The fetch callback queues and the user sees
	// "Loading…" in DevTools until they hit resume. Eager parse + pinned
	// bytecode keeps the source on the Script object, so getScriptSource
	// returns synchronously from inspector-accessible memory. Non-trivial
	// memory cost on large pages; acceptable because scramdiff runs exercise
	// a bounded set of scripts.
	const jsFlags = [
		`--random-seed=${opts.randomSeed}`,
		"--no-concurrent-marking",
		"--no-lazy",
		"--no-flush-bytecode",
	].join(" ");
	const args = [
		`--js-flags=${jsFlags}`,
		"--use-gl=swiftshader",
		"--disable-accelerated-2d-canvas",
		"--disable-gpu-compositing",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-ipc-flooding-protection",
		"--disable-field-trial-config",
		// Script streaming and off-thread compile both hand script bytes to a
		// background parser and drop the byte buffer once compile finishes —
		// from that moment on, Debugger.getScriptSource is a re-fetch. The
		// feature's been renamed across Chromium versions; cover each variant:
		//   ScriptStreaming              (legacy name, blink::features)
		//   BackgroundScriptStreaming    (current name)
		//   V8ScriptStreaming            (post-rename fallback)
		//   OffThreadCSSParser           (loosely related; parser doesn't drop text either way)
		//   ConsumeCodeCacheOffThread    (can race with source retention)
		// We also disable HTTP cache's side-effectful "script resource text
		// drop after first compile" heuristic via ScriptResourceOptimizedLoading.
		"--disable-features=TranslateUI,IsolateOrigins,site-per-process,PaintHolding,ScriptStreaming,BackgroundScriptStreaming,V8ScriptStreaming,ConsumeCodeCacheOffThread,ScriptResourceOptimizedLoading",
		"--enable-features=NetworkService",
		"--force-color-profile=srgb",
		"--no-first-run",
		"--no-default-browser-check",
		"--ignore-certificate-errors",
	];
	if (extras?.autoOpenDevtools) {
		args.push("--auto-open-devtools-for-tabs");
	}
	return args;
}

/**
 * Apply CDP-level determinism controls to a session. Called once per attached
 * target; virtual time is re-armed per navigation below.
 */
export async function applyDeterminismToSession(
	cdp: CDPSession,
	opts: DeterminismOptions
) {
	// Use fixed initial time so Date.now() starts identical across runs.
	// Chromium's DevTools Emulation.setVirtualTimePolicy sets a logical clock
	// shared by Date and performance.now().
	await cdp.send("Page.enable").catch(() => {});
	await cdp.send("Runtime.enable").catch(() => {});
	await cdp.send("Network.enable").catch(() => {});

	// Precise coverage: needed for control-flow divergence signal.
	await cdp.send("Profiler.enable").catch(() => {});
	await cdp
		.send("Profiler.startPreciseCoverage", {
			callCount: true,
			detailed: true,
			allowTriggeredUpdates: true,
		})
		.catch(() => {});

	// Freeze Date-level time advance to be event-driven, not wall-clock.
	if (opts.enableVirtualTime) {
		await cdp
			.send("Emulation.setVirtualTimePolicy", {
				policy: "pauseIfNetworkFetchesPending",
				budget: opts.virtualTimeBudgetMs,
				initialVirtualTime: 0,
			})
			.catch(() => {});
	}

	// Deterministic timezone and locale.
	await cdp
		.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" })
		.catch(() => {});
	await cdp
		.send("Emulation.setLocaleOverride", { locale: "en-US" })
		.catch(() => {});
}

/**
 * Re-arm the virtual time budget before a navigation. Chromium consumes the
 * budget as tasks run; without this you get one navigation's worth and then
 * the clock stops.
 */
export async function rearmVirtualTime(
	cdp: CDPSession,
	opts: DeterminismOptions
) {
	if (!opts.enableVirtualTime) return;
	await cdp
		.send("Emulation.setVirtualTimePolicy", {
			policy: "pauseIfNetworkFetchesPending",
			budget: opts.virtualTimeBudgetMs,
		})
		.catch(() => {});
}
