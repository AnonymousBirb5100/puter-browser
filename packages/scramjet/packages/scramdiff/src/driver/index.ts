/**
 * Top-level driver.
 *
 * Owns everything: one Chromium, an internal scramjet harness server (Express
 * + wisp on random loopback ports), and two harness pipelines:
 *
 *   - direct   → a Playwright context that navigates straight to the target URL.
 *   - scramjet → a Playwright context whose *single page* first loads the
 *                harness bootstrap (registers the scramjet SW, initializes
 *                the Controller, exposes window.__scramdiffEncode), then
 *                encodes the target URL and top-level navigates the same
 *                page to the proxy URL. Same origin → the bootstrap-registered
 *                SW controls the target navigation.
 *
 * One page per harness keeps CDP sessions, virtual time, and event buffers
 * strictly isolated. We tried sharing a context between a separate bootstrap
 * tab and the target tab; Chromium's Emulation.setVirtualTimePolicy turned
 * out to interact badly with a second page in the same context and closed
 * the bootstrap. One page per harness sidesteps that entirely.
 *
 * The scramjet run observes the site as a top-level document, not an iframe
 * — critical because many APIs (top/parent, window.name inheritance, CSP,
 * SW scoping, storage partitioning) behave differently inside iframes.
 */

import { chromium, type Browser } from "playwright";
import { createHarness, type HarnessRun } from "./harness.ts";
import {
	chromiumLaunchArgs,
	DETERMINISM_DEFAULTS,
	type DeterminismOptions,
} from "./determinism.ts";
import { startHarnessServer, type HarnessServer } from "./harness-server.ts";
import type { RunArtifacts } from "../trace.ts";

export type DriverOptions = {
	determinism?: Partial<DeterminismOptions>;
	headless?: boolean;
	/**
	 * Optional logger for driver-side progress output. Defaults to stderr.
	 * Set to a no-op to silence.
	 */
	log?: (line: string) => void;
	/**
	 * Which harness(es) to spin up.
	 *   - "both" (default): classic live diff. Runs direct + scramjet sequentially.
	 *   - "direct": only direct harness. The run() callback's `scramjet` field is null.
	 *   - "scramjet": only scramjet harness. The run() callback's `direct` field is null.
	 * Used to support record (direct-only + ND capture) and replay (scramjet-only
	 * with pre-seeded ND values) pipelines in the CLI.
	 */
	sides?: "both" | "direct" | "scramjet";
	/**
	 * ND capture/replay configuration, forwarded into each harness's ProbeConfig.
	 *   - direct ndMode: "record" for record flow; "observe" (default) otherwise.
	 *   - scramjet ndMode: "replay" for replay flow (must supply scramjet.ndCaptures);
	 *     "observe" (default) otherwise.
	 * See ProbeConfig in probe.ts for mode semantics.
	 */
	nd?: {
		direct?: { mode: "observe" | "record"; captures?: Record<string, any[]> };
		scramjet?: { mode: "observe" | "replay"; captures?: Record<string, any[]> };
	};
	/**
	 * Breakpoint: run the probe with a `debugger;` trigger on the N-th
	 * site-originated (api, op) call. By default applied to the scramjet
	 * harness only; when `applyBreakpointToDirect` is set, the direct
	 * harness also receives the same breakpoint so both sides can be halted
	 * side-by-side at the conceptually-equivalent call for comparison.
	 *
	 * When applied to a harness, that harness enables CDP Debugger and
	 * stays paused until the caller invokes the respective resume on
	 * DriverControls.
	 */
	breakpoint?: {
		api: string;
		op?: "call" | "construct" | "get" | "set";
		matchIndex: number;
	};
	/**
	 * When true AND `breakpoint` is set AND the direct harness is being
	 * run (sides="both" or "direct"), the direct harness also gets the
	 * breakpoint and CDP Debugger enabled. Semantically: "also launch a
	 * non-scramjet window that pauses at the same logical call."
	 * Counter-parity between the two harnesses is not guaranteed — the
	 * matchIndex refers to *this harness's* site-originated call counter —
	 * but for site code that makes the same API calls the counts align.
	 */
	applyBreakpointToDirect?: boolean;
	/**
	 * Optional callback fired whenever a harness halts at the configured
	 * breakpoint. Receives the harness side and the raw CDP Debugger.paused
	 * event; store it somewhere the GUI can observe.
	 */
	onPaused?: (side: "direct" | "scramjet", ev: any) => void;
};

export type DriverRun = {
	direct: RunArtifacts | null;
	scramjet: RunArtifacts | null;
};

/**
 * Control surface exposed to the body callback for sessions that may pause
 * on a breakpoint. Per-side because each harness has its own pause state;
 * e.g. scramjet might be halted while direct is still running, or both might
 * be halted waiting for the user to compare.
 */
export type DriverControls = {
	/** Resume the scramjet harness if currently halted at a breakpoint. */
	resumeScramjet(): Promise<void>;
	/** Resume the direct harness if currently halted at a breakpoint. */
	resumeDirect(): Promise<void>;
	/** True iff scramjet is currently paused at a breakpoint. */
	isScramjetPaused(): boolean;
	/** True iff direct is currently paused at a breakpoint. */
	isDirectPaused(): boolean;
};

export async function withDriver<T>(
	opts: DriverOptions,
	body: (
		run: (targetUrl: string) => Promise<DriverRun>,
		controls: DriverControls
	) => Promise<T>
): Promise<T> {
	const det: DeterminismOptions = {
		...DETERMINISM_DEFAULTS,
		...opts.determinism,
	};
	if (opts.headless !== undefined) det.headless = opts.headless;

	const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));

	log("starting internal scramjet harness server…");
	const server: HarnessServer = await startHarnessServer();
	log(`harness http: ${server.rootUrl}`);
	log(`harness wisp: ${server.wispUrl}`);

	// Auto-open DevTools only for headed breakpoint runs. Opening DevTools
	// before page scripts parse means DevTools' CDP session subscribes to
	// `Debugger.scriptParsed` from the very first frame — by the time a
	// `debugger;` halts execution, DevTools already has script identity for
	// every frame on the stack and can render source from V8's (pinned)
	// Script object memory directly. Attaching DevTools *after* a pause, on
	// the other hand, means its first getScriptSource on a legacy script
	// can fall through to a Blink-side re-fetch that deadlocks against the
	// paused main thread.
	const autoOpenDevtools = !det.headless && !!opts.breakpoint;
	log(
		`launching chromium (headless=${det.headless}${autoOpenDevtools ? ", devtools=auto" : ""})…`
	);
	const browser: Browser = await chromium.launch({
		headless: det.headless,
		args: chromiumLaunchArgs(det, { autoOpenDevtools }),
	});

	const runId =
		(globalThis as any).crypto?.randomUUID?.() ?? String(Date.now());
	const sides = opts.sides ?? "both";
	const needDirect = sides === "both" || sides === "direct";
	const needScramjet = sides === "both" || sides === "scramjet";

	let directHarness: HarnessRun | null = null;
	let scramjetHarness: HarnessRun | null = null;

	try {
		if (needDirect) {
			log("creating direct harness…");
			const directBreakpoint =
				opts.breakpoint && opts.applyBreakpointToDirect
					? opts.breakpoint
					: undefined;
			directHarness = await createHarness({
				browser,
				harness: "direct",
				determinism: det,
				enableDebugger: !!directBreakpoint,
				onPaused: opts.onPaused
					? (ev) => opts.onPaused!("direct", ev)
					: undefined,
				probeConfig: {
					runId: runId + "-direct",
					maxEventsPerTask: 10_000,
					trackDataProperties: false,
					ndMode: opts.nd?.direct?.mode ?? "observe",
					ndCaptures: opts.nd?.direct?.captures,
					breakpoint: directBreakpoint,
				},
				loadTarget: async (url, { page }) => {
					// Plain top-level navigation. Playwright timeouts here are
					// driver heuristics, not page errors — catch silently.
					await page
						.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
						.catch(() => {});
					await page
						.waitForLoadState("load", { timeout: 15_000 })
						.catch(() => {});
					try {
						return await page.evaluate(() => location.href);
					} catch {
						return url;
					}
				},
			});
		}

		if (needScramjet) {
			log("creating scramjet harness…");
			scramjetHarness = await createHarness({
				browser,
				harness: "scramjet",
				determinism: det,
				enableDebugger: !!opts.breakpoint,
				onPaused: opts.onPaused
					? (ev) => opts.onPaused!("scramjet", ev)
					: undefined,
				probeConfig: {
					runId: runId + "-scramjet",
					maxEventsPerTask: 10_000,
					trackDataProperties: false,
					ndMode: opts.nd?.scramjet?.mode ?? "observe",
					ndCaptures: opts.nd?.scramjet?.captures,
					breakpoint: opts.breakpoint,
				},
				loadTarget: async (url, { page }) => {
					// Scramjet only works in its full context — you need the
					// bootstrap page with a registered iframe, then navigate that
					// iframe via the controller's Frame.go() (which rewrites the
					// URL and sets iframe.src; setting .src on a random iframe or
					// doing a top-level navigate to a proxy URL hangs because the
					// SW has no frame context to bind the request to).
					const bootstrapUrl =
						server.rootUrl + "/__scramdiff_harness_bootstrap";
					const currentUrl = page.url();
					if (currentUrl.indexOf("__scramdiff_harness_bootstrap") === -1) {
						log(`  bootstrap → ${bootstrapUrl}`);
						page.on("console", (msg) =>
							log(`  [bootstrap ${msg.type()}] ${msg.text()}`)
						);
						page.on("pageerror", (e) =>
							log(`  [bootstrap pageerror] ${e.message}`)
						);
						await page.goto(bootstrapUrl, {
							waitUntil: "load",
							timeout: 60_000,
						});
						await page.waitForFunction(
							() =>
								(globalThis as any).__scramdiffHarnessReady === true ||
								(globalThis as any).__scramdiffHarnessError,
							{ timeout: 60_000 }
						);
						const err = await page.evaluate(
							() => (globalThis as any).__scramdiffHarnessError ?? null
						);
						if (err) throw new Error(`scramjet bootstrap failed: ${err}`);
					}

					log(`  frame.go(${url})`);
					// __scramdiffNavigate resolves when the iframe fires 'load'
					// (or after a 45s grace inside the page, whichever comes first).
					// Returns the iframe's final URL for the report.
					const finalUrl = await page.evaluate(
						(u: string) =>
							(globalThis as any).__scramdiffNavigate(u) as Promise<string>,
						url
					);
					log(`  iframe url → ${finalUrl}`);
					return finalUrl;
				},
			});
		}

		const run = async (targetUrl: string): Promise<DriverRun> => {
			// Normally sequential: both runs hit the real origin through
			// different code paths; running them in parallel would race the
			// origin server and its state (cookies/CDN/edge A/B) against
			// itself, blurring signal.
			//
			// Exception: when a breakpoint is applied to both sides, we must
			// run in parallel — otherwise scramjet hits `debugger;` and
			// blocks forever because direct's run never starts, meaning the
			// user can't ever see direct paused at the same call. Parallel
			// costs correctness for breakpoint comparison UX; that trade-off
			// is the point of the feature.
			const parallel =
				!!opts.breakpoint &&
				!!opts.applyBreakpointToDirect &&
				!!scramjetHarness &&
				!!directHarness;
			let scramjet: RunArtifacts | null = null;
			let direct: RunArtifacts | null = null;
			if (parallel) {
				log(`→ parallel run (breakpoint both sides): ${targetUrl}`);
				const [sRes, dRes] = await Promise.all([
					scramjetHarness!.run(targetUrl),
					directHarness!.run(targetUrl),
				]);
				scramjet = sRes;
				direct = dRes;
				log(
					`  scramjet events: ${countEvents(scramjet)} finalUrl=${scramjet.finalUrl}`
				);
				log(
					`  direct events: ${countEvents(direct)} finalUrl=${direct.finalUrl}`
				);
			} else {
				if (scramjetHarness) {
					log(`→ scramjet run: ${targetUrl}`);
					scramjet = await scramjetHarness.run(targetUrl);
					log(
						`  scramjet events: ${countEvents(scramjet)} finalUrl=${scramjet.finalUrl}`
					);
				}
				if (directHarness) {
					log(`→ direct run: ${targetUrl}`);
					direct = await directHarness.run(targetUrl);
					log(
						`  direct events: ${countEvents(direct)} finalUrl=${direct.finalUrl}`
					);
				}
			}
			return { direct, scramjet };
		};

		const controls: DriverControls = {
			async resumeScramjet() {
				if (scramjetHarness) await scramjetHarness.resume();
			},
			async resumeDirect() {
				if (directHarness) await directHarness.resume();
			},
			isScramjetPaused() {
				return !!(scramjetHarness && scramjetHarness.isPaused());
			},
			isDirectPaused() {
				return !!(directHarness && directHarness.isPaused());
			},
		};
		return await body(run, controls);
	} finally {
		log("shutting down…");
		if (scramjetHarness) await scramjetHarness.close().catch(() => {});
		if (directHarness) await directHarness.close().catch(() => {});
		await browser.close().catch(() => {});
		await server.close().catch(() => {});
	}
}

function countEvents(r: RunArtifacts): number {
	let n = 0;
	for (const k of Object.keys(r.traces)) n += r.traces[k].length;
	return n;
}
