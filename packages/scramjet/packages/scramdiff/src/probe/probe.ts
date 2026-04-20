/**
 * The in-page probe.
 *
 * Emitted as JS source via `buildProbeScript()` and injected via
 * `Page.addScriptToEvaluateOnNewDocument` before any page script runs.
 *
 * Responsibilities, in order:
 *
 *   1. Eagerly capture native refs we depend on (Object.*, Reflect.*, JSON.*,
 *      Symbol, Error, Promise, TextEncoder/Decoder, ...) so the probe works
 *      even when scramjet (or the page) mutates globals.
 *
 *   2. Enumerate every reachable Web IDL member from this global using
 *      ENUMERATE_SRC. We wrap every one of them — not just APIs scramjet
 *      wraps, because the bugs worth finding are exactly the ones where
 *      scramjet failed to wrap something that leaks rewritten state.
 *
 *   3. Wait until scramjet has finished installing its interceptors (detected
 *      by the presence of Symbol.for("scramjet client global") on the global,
 *      plus a microtask yield so all hook modules run). In the direct run,
 *      there's no scramjet, so we install immediately after enumeration.
 *
 *   4. For each enumerated member, install an OUTER wrapper by replacing the
 *      descriptor on the owning prototype (or the global). The wrapper:
 *        - On invocation/read, runs the inner function/getter (which in the
 *          scramjet run is scramjet's interceptor; in the direct run is the
 *          native). This is the "post" value — what JS actually observes.
 *        - In the scramjet run, also looks up the native in
 *          \`window[SCRAMJETCLIENT].natives.store\` /
 *          \`.descriptors.store\` (if scramjet intercepted that path) and
 *          invokes IT to capture the "pre" value — what the underlying
 *          browser would have returned with no scramjet in the way.
 *        - Emits a TraceEvent with both to the CDP binding.
 *
 *   5. Task boundaries are approximated with a monotonic "task generation"
 *      counter that increments whenever the probe is re-entered from an
 *      empty call stack. Causal matching in the differ is best-effort; we'll
 *      upgrade to scheduler-hooked lineage later.
 */

import { ENUMERATE_SRC } from "./enumerate.ts";

/**
 * Minimal shape of config passed from the driver into the probe.
 * Serialized to JSON and inlined into the injected script.
 */
export type ProbeConfig = {
	harness: "direct" | "scramjet";
	/** Random seed echoed into the probe's logs for correlation. */
	runId: string;
	/** Ceiling on emitted events per task, to avoid DoSing the binding. */
	maxEventsPerTask: number;
	/** Whether to also record data-property members (mutation tracking). */
	trackDataProperties: boolean;
	/**
	 * Nondeterminism capture/replay mode.
	 *   - "observe": the default, used for live diff and the direct half of
	 *     live diff. The probe doesn't touch ND sources beyond what it wraps
	 *     for normal tracing (V8 --random-seed handles the rest).
	 *   - "record": wrap ND sources (Math.random, Date.now, Performance.prototype.now,
	 *     Performance.prototype.timeOrigin, Crypto.prototype.randomUUID,
	 *     Crypto.prototype.getRandomValues), call native, and emit each return
	 *     value to the driver as `__scramdiff.nd.record` events.
	 *   - "replay": wrap the same ND sources but, for site-originated calls,
	 *     drain values from a pre-seeded per-api FIFO instead of calling native.
	 *     Calls from scramjet's own runtime or the probe fall through to native.
	 */
	ndMode: "observe" | "record" | "replay";
	/**
	 * Only used when ndMode === "replay". One FIFO per API path; the probe
	 * consumes values in the order they were recorded. Empty / missing queues
	 * cause a fall-through to native plus a diagnostic emit.
	 */
	ndCaptures?: Record<string, any[]>;
	/**
	 * Optional breakpoint: when set, the probe counts per-(api,op) site-originated
	 * calls and on the N-th match emits a __scramdiff.bp.hit event and executes
	 * a debugger statement. When the harness has Debugger.enable'd via CDP (see
	 * HarnessOptions.enableDebugger), the debugger statement halts the page
	 * and the driver surfaces a paused state to callers.
	 */
	breakpoint?: {
		/** Fully-qualified api path, e.g. "Document.prototype.cookie". */
		api: string;
		/** Optional op filter. Omit to match any op on this api. */
		op?: "call" | "construct" | "get" | "set";
		/** 1-indexed count among site-originated (api,op) calls. */
		matchIndex: number;
	};
};

export function buildProbeScript(config: ProbeConfig): string {
	return `
(() => {
	"use strict";
	if (globalThis.__scramdiffProbeInstalled) return;
	globalThis.__scramdiffProbeInstalled = true;

	// The scramjet harness bootstrap page at /__scramdiff_bootstrap needs to load
	// scramjet / controller / libcurl scripts cleanly, without the probe
	// wrapping APIs those scripts use at load time (which causes re-entry
	// stack overflows). We skip the probe entirely on that page; the actual
	// instrumented target page (scramjet-proxied) is where we want wrapping.
	//
	// Also skip about:blank and empty-URL frames. Playwright's addInitScript
	// fires on every document in every frame, including the iframe's initial
	// blank document that exists before frame.go() navigates it. Instrumenting
	// blank produces a duplicate enumerate/installed heartbeat per run and
	// zero page-observable events — pure noise.
	try {
		const href = String((globalThis.location && globalThis.location.href) || "");
		if (href.indexOf("/__scramdiff_harness_bootstrap") !== -1) return;
		if (href === "" || href === "about:blank" || href.indexOf("about:") === 0) return;
	} catch (_) {}

	const CONFIG = ${JSON.stringify(config)};

	// ---------- cached natives ----------
	const O = Object;
	const O_getOwnPropertyNames = O.getOwnPropertyNames;
	const O_getOwnPropertySymbols = O.getOwnPropertySymbols;
	const O_getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
	const O_defineProperty = O.defineProperty;
	const O_getPrototypeOf = O.getPrototypeOf;
	const R_apply = Reflect.apply;
	const R_construct = Reflect.construct;
	const R_get = Reflect.get;
	const R_set = Reflect.set;
	const J_stringify = JSON.stringify;
	const S_for = Symbol.for;
	const P_resolve = Promise.resolve.bind(Promise);
	const SCRAMJETCLIENT = S_for("scramjet client global");
	// Snapshot atob before scramjet or our own wrappers touch it; used by the
	// data-URL content sniff below, which has to run inside analyzeStack() on
	// every API call and must never re-enter an instrumented path.
	const A_atob = (typeof globalThis.atob === "function") ? globalThis.atob.bind(globalThis) : null;
	const A_decodeURIComponent = (typeof globalThis.decodeURIComponent === "function") ? globalThis.decodeURIComponent.bind(globalThis) : null;

	// ---------- binding ----------
	// The driver exposes \`__scramdiffEmit\` via CDP Runtime.addBinding. It accepts
	// a single JSON string argument. We buffer while the binding is being attached.
	const pending = [];
	let bindingReady = typeof globalThis.__scramdiffEmit === "function";
	function emit(event) {
		const payload = safeStringify(event);
		if (bindingReady) {
			try { globalThis.__scramdiffEmit(payload); return; } catch { bindingReady = false; }
		}
		pending.push(payload);
	}
	function flushPending() {
		if (!bindingReady) {
			bindingReady = typeof globalThis.__scramdiffEmit === "function";
		}
		if (!bindingReady) return;
		while (pending.length > 0) {
			const p = pending.shift();
			try { globalThis.__scramdiffEmit(p); } catch { bindingReady = false; pending.unshift(p); return; }
		}
	}
	// Poll for the binding in case the driver attaches after initial script runs.
	const bindingPoll = setInterval(() => {
		flushPending();
	}, 16);

	function safeStringify(obj) {
		try {
			return J_stringify(obj, (_k, v) => {
				if (typeof v === "bigint") return { __t: "bigint", v: v.toString() };
				return v;
			});
		} catch (e) {
			return J_stringify({ __serializationFailed: true, reason: String(e && e.message || e) });
		}
	}

	// ---------- value summarization ----------
	// Serialize any value into a TraceValue the differ can compare. We do NOT
	// deep-serialize DOM nodes or exotic objects — too expensive and noisy.
	// Instead we capture a structural fingerprint: ctor name, short description,
	// and a stable hash.
	function djb2(s) {
		let h = 5381;
		for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
		return (h >>> 0).toString(16);
	}

	function summarizeValue(v) {
		if (v === null) return { t: "primitive", v: null };
		if (v === undefined) return { t: "undefined" };
		const ty = typeof v;
		if (ty === "string") return { t: "string", v: v };
		if (ty === "number" || ty === "boolean") return { t: "primitive", v: v };
		if (ty === "bigint") return { t: "bigint", v: v.toString() };
		if (ty === "symbol") return { t: "symbol", v: v.description || v.toString() };
		if (ty === "function") {
			let name = ""; let length = 0;
			try { name = v.name || ""; } catch {}
			try { length = v.length || 0; } catch {}
			return { t: "function", name, length };
		}
		// Objects & arrays
		try {
			if (v instanceof Error) {
				return { t: "error", name: v.name || "Error", message: String(v.message || "") };
			}
		} catch {}

		let ctor = "Object";
		try {
			const c = O_getPrototypeOf(v);
			if (c && c.constructor && c.constructor.name) ctor = c.constructor.name;
		} catch {}

		// Array-ish
		try {
			if (Array.isArray(v)) {
				const summary = v.slice(0, 8).map((x) => {
					if (x === null) return "null";
					if (x === undefined) return "undefined";
					const t = typeof x;
					if (t === "string") return J_stringify(x.length > 64 ? x.slice(0, 64) + "…" : x);
					if (t === "number" || t === "boolean" || t === "bigint") return String(x);
					return "[" + t + "]";
				}).join(",");
				const s = "[" + summary + (v.length > 8 ? ",…+" + (v.length - 8) : "") + "]";
				return { t: "array", length: v.length, summary: s, hash: djb2(ctor + ":" + s) };
			}
		} catch {}

		// DOM nodes get a description that includes tag + id + a few attrs, so
		// two elements at the "same logical position" produce the same summary.
		try {
			if (typeof v.nodeType === "number" && typeof v.nodeName === "string") {
				let desc = v.nodeName.toLowerCase();
				try { if (v.id) desc += "#" + String(v.id); } catch {}
				try {
					const cls = v.className;
					if (typeof cls === "string" && cls) desc += "." + cls.split(/\\s+/).slice(0, 3).join(".");
				} catch {}
				return { t: "dom", ctor, desc };
			}
		} catch {}

		// Fallback: enumerate up to 8 keys into a summary string.
		let keys;
		try { keys = O_getOwnPropertyNames(v); } catch { keys = []; }
		const parts = [];
		for (let i = 0; i < Math.min(keys.length, 8); i++) {
			let val;
			try { val = v[keys[i]]; } catch { val = "<throws>"; }
			const t = typeof val;
			if (t === "string") parts.push(keys[i] + ":" + J_stringify(val.length > 64 ? val.slice(0, 64) + "…" : val));
			else if (t === "number" || t === "boolean" || t === "bigint") parts.push(keys[i] + ":" + String(val));
			else parts.push(keys[i] + ":[" + t + "]");
		}
		const s = "{" + parts.join(",") + "}";
		return { t: "object", ctor, summary: s, hash: djb2(ctor + ":" + s) };
	}

	// ---------- task tracking ----------
	let runSeq = 0;
	let taskSeq = 0;
	let taskGeneration = 0;
	let inProbeDepth = 0;
	let eventsInCurrentTask = 0;
	// Re-entry guard. When a wrapper callback is running, any nested wrapped-API
	// invocation (from safeStringify, callSite's new Error(), etc.) bypasses
	// instrumentation and just passes through. Without this, wrapping ECMAScript
	// built-ins — even partially — causes infinite recursion. We also skip
	// ECMA core in enumerate.ts, but belt-and-suspenders: the recursion guard
	// protects against any instance method we wrap whose implementation in turn
	// calls another method we've wrapped.
	let probeReentry = false;
	// When the call stack is fully unwound (between event loop turns), the next
	// wrapper entry kicks off a new task.
	function enterTask() {
		if (inProbeDepth === 0) {
			taskGeneration++;
			taskSeq = 0;
			eventsInCurrentTask = 0;
		}
		inProbeDepth++;
	}
	function leaveTask() {
		inProbeDepth--;
	}
	function currentTaskId() {
		// Best-effort causal ID: virtual time + generation.
		// Real scheduler lineage comes later (hook setTimeout/then/etc.).
		const vtime = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
		return "g" + taskGeneration + "@" + Math.round(vtime * 1000);
	}

	// ---------- call site attribution + scramjet-initiated filter ----------
	// Scramjet's client runtime appears in stack traces in three forms:
	//
	//   1. Bare harness paths:   http://HOST:PORT/scramjet/scramjet.js, etc.
	//   2. Rewritten paths:      http://HOST:PORT/~/sj/<ctxA>/<ctxB>/scramjet.wasm.js
	//                            — scramjet rewrites its OWN script URLs through
	//                            its SW too, so you can't match on path prefix.
	//   3. Data-URL injections:  <script src="data:text/javascript;base64,..."
	//                            scramjet-injected="true"> — scramjet's
	//                            post-load cleanup / worker bootstrap injector
	//                            (see controller/src/index.ts:yieldGetInjectScripts).
	//                            These show up as the entire data: URL in stack
	//                            frames.
	//
	// We match (1) and (2) by BASENAME, and (3) by decoding the base64 payload
	// and sniffing for the string "scramjet" (scramjet's injections always
	// reference themselves).
	const SCRAMJET_FRAME_RE = /\\/(?:scramjet\\.(?:wasm\\.)?js|controller\\.(?:api|inject|sw)\\.js|(?:libcurl|epoxy|bare)-client\\.js)(?:[:?#]|$)/;

	// Memoize verdicts per unique URL — the same data: URL can appear in every
	// frame of a long stack, and base64-decoding 4KB payloads per call adds up.
	const dataUrlVerdict = new Map();
	function isScramjetDataUrl(url) {
		if (!url || url.charCodeAt(0) !== 100 /* 'd' */ || url.indexOf("data:") !== 0) return false;
		let v = dataUrlVerdict.get(url);
		if (v !== undefined) return v;
		v = false;
		try {
			const comma = url.indexOf(",");
			if (comma < 0) { dataUrlVerdict.set(url, false); return false; }
			const prefix = url.slice(0, comma);
			// Only javascript/ecmascript MIME types are plausibly code frames.
			if (prefix.indexOf("javascript") === -1 && prefix.indexOf("ecmascript") === -1) {
				dataUrlVerdict.set(url, false); return false;
			}
			const body = url.slice(comma + 1);
			let decoded = "";
			if (prefix.indexOf("base64") !== -1) {
				if (A_atob) decoded = A_atob(body);
			} else {
				if (A_decodeURIComponent) decoded = A_decodeURIComponent(body);
			}
			// Scramjet's injections reference themselves textually. User pages
			// that happen to embed the literal word "scramjet" in an inline
			// data-URL script are vanishingly rare; if we get a false positive,
			// we drop one diff event, not an entire page.
			v = decoded.indexOf("scramjet") !== -1;
		} catch { v = false; }
		dataUrlVerdict.set(url, v);
		return v;
	}

	// Parse a V8 stack frame line into { url, line, column }. The naive pattern
	// \`([^():\\s]+):(\\d+):(\\d+)\` breaks on data: URLs, which are typically
	// "data:text/javascript;base64,..." and contain colons and slashes before
	// the line/col. Anchor on ":L:C" at the end of the line and walk left
	// instead: everything before the line number (after the last "(" or the
	// leading "at ") is the URL.
	function parseStackLine(ln) {
		// Strip any trailing ")" + whitespace that wraps the parenthesized form.
		const tail = ln.replace(/[)\\s]*$/, "");
		const colIdx = tail.lastIndexOf(":");
		if (colIdx <= 0) return null;
		const lineIdx = tail.lastIndexOf(":", colIdx - 1);
		if (lineIdx <= 0) return null;
		const lineStr = tail.slice(lineIdx + 1, colIdx);
		const colStr = tail.slice(colIdx + 1);
		if (!/^\\d+$/.test(lineStr) || !/^\\d+$/.test(colStr)) return null;
		let urlPart = tail.slice(0, lineIdx);
		const openParen = urlPart.lastIndexOf("(");
		if (openParen >= 0) {
			urlPart = urlPart.slice(openParen + 1);
		} else {
			// Drop leading "at " / "at async " / whitespace.
			urlPart = urlPart.replace(/^\\s*at\\s+(?:async\\s+)?/, "");
			urlPart = urlPart.replace(/^\\s+/, "");
		}
		return { url: urlPart, line: Number(lineStr), column: Number(colStr) };
	}

	// Walk the current stack once and return:
	//   - callerIsScramjet: the first foreign (non-probe) frame is scramjet runtime
	//   - url/line/column: that same frame, for reporting (truncated for sanity)
	// The probe tags its own script with //# sourceURL=scramdiff:probe (see bottom
	// of this IIFE), so its frames show up as "scramdiff:probe:LINE:COL" and are
	// trivially skippable.
	function analyzeStack() {
		const err = new Error();
		const stack = err.stack || "";
		const lines = stack.split("\\n");
		let callerIsScramjet = false;
		let callerIsProbe = true; // assume probe-self until we see a non-probe frame
		let url, line, column;
		// Also scan the rest of the stack. If no user frame appears above the
		// immediate non-probe caller and scramjet shows up anywhere in the
		// stack, we still consider the call scramjet-initiated — this catches
		// cases where the immediate frame is a native/VM callback (no URL) but
		// the actual initiator further up is scramjet code.
		let scramjetAnywhere = false;
		let sawFirstNonProbe = false;
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i];
			if (!ln) continue;
			// Probe's own frames — see sourceURL directive.
			if (ln.indexOf("scramdiff:probe") !== -1) continue;
			// Older name-based fallback in case sourceURL is stripped somewhere.
			if (ln.indexOf("__scramdiff") !== -1) continue;
			if (ln.indexOf("scramdiffProbe") !== -1) continue;
			// Skip the "Error" header line (no file:line:col).
			if (!/[:@(]/.test(ln)) continue;
			callerIsProbe = false;
			const p = parseStackLine(ln);
			const frameIsScramjet = !!(p && p.url && (SCRAMJET_FRAME_RE.test(p.url) || isScramjetDataUrl(p.url)));
			if (!sawFirstNonProbe) {
				// First non-probe frame. This is the immediate non-probe caller:
				// user code, scramjet code, or a native/VM frame. Its url/line/col
				// is what we report; if it's scramjet-owned, filter right here.
				sawFirstNonProbe = true;
				if (p) { url = p.url; line = p.line; column = p.column; }
				if (frameIsScramjet) { callerIsScramjet = true; break; }
				// If the first non-probe frame has no URL (native/VM frame), we
				// keep walking to see if the call was *initiated* by scramjet.
				// If instead it has a URL that isn't scramjet-owned, it's a real
				// user frame — stop, don't let upstream scramjet frames poison
				// the filter (per user requirement: immediate non-probe caller
				// is what matters).
				if (p && p.url) break;
				continue;
			}
			if (frameIsScramjet) { scramjetAnywhere = true; break; }
		}
		if (!callerIsScramjet && scramjetAnywhere) callerIsScramjet = true;
		// Cap scriptUrl length — data URLs can be 4KB+ each, and we store
		// scriptUrl on every emitted event.
		if (url && url.length > 256) {
			url = url.slice(0, 240) + "…[" + url.length + " chars]";
		}
		// If we never even found a non-probe frame with a URL but the call
		// wasn't probe-self (so callerIsProbe is false — came in from native
		// callback etc), leave url undefined. Rare.
		return { callerIsScramjet, callerIsProbe, url, line, column };
	}

	// ---------- scramjet stash lookup ----------
	// In the scramjet run, scramjet stashes native refs at install time in
	// client.natives.store (for Proxy-wrapped ops) and client.descriptors.store
	// (for Trap-wrapped attributes). We look them up to capture pre values.
	function scramjetNativeCall(path, thisArg, args) {
		try {
			const client = globalThis[SCRAMJETCLIENT];
			if (!client) return { have: false };
			const fn = client.natives.store[path];
			if (typeof fn !== "function") return { have: false };
			return { have: true, value: R_apply(fn, thisArg, args) };
		} catch (e) {
			return { have: true, threw: true, value: e };
		}
	}
	function scramjetNativeConstruct(path, args) {
		try {
			const client = globalThis[SCRAMJETCLIENT];
			if (!client) return { have: false };
			const fn = client.natives.store[path];
			if (typeof fn !== "function") return { have: false };
			return { have: true, value: R_construct(fn, args) };
		} catch (e) {
			return { have: true, threw: true, value: e };
		}
	}
	function scramjetNativeGet(path, thisArg) {
		try {
			const client = globalThis[SCRAMJETCLIENT];
			if (!client) return { have: false };
			const desc = client.descriptors.store[path];
			if (!desc || !desc.get) return { have: false };
			return { have: true, value: R_apply(desc.get, thisArg, []) };
		} catch (e) {
			return { have: true, threw: true, value: e };
		}
	}

	// ---------- nondeterminism capture / replay ----------
	// ND sources: APIs whose native return value is nondeterministic under
	// V8's predictable mode (or whose "reasonable" determinism leak anyway,
	// in the case of crypto). Record mode captures each native return value;
	// replay mode feeds site-code the recorded values instead of calling native.
	//
	// On record: each call pushes one capture into emits-buffered arrays via
	// the \`__scramdiff.nd.record\` event api so the driver can persist them.
	// On replay: we drain a per-api FIFO pre-seeded in CONFIG.ndCaptures.
	//
	// Scope: site-originated calls only. Scramjet's own runtime and the probe
	// always hit native — otherwise scramjet's internal Math.random() calls
	// would consume captures meant for the site's code.
	const A_Math_random = Math.random;
	const A_Date_now = Date.now;
	const A_perf_now = (typeof performance !== "undefined" && performance.now) ? performance.now.bind(performance) : null;

	// Pre-bake a native-bytes copy helper. ArrayBufferView subclasses: get the
	// underlying ArrayBuffer + byteOffset + byteLength, overwrite those bytes.
	const A_Uint8Array = Uint8Array;
	function bytesToHex(view) {
		try {
			const u8 = new A_Uint8Array(view.buffer, view.byteOffset, view.byteLength);
			let s = "";
			for (let i = 0; i < u8.length; i++) {
				const b = u8[i];
				s += (b < 16 ? "0" : "") + b.toString(16);
			}
			return s;
		} catch { return ""; }
	}
	function writeHexIntoView(view, hex) {
		try {
			const u8 = new A_Uint8Array(view.buffer, view.byteOffset, view.byteLength);
			const n = Math.min(u8.length, (hex.length / 2) | 0);
			for (let i = 0; i < n; i++) {
				u8[i] = parseInt(hex.substr(i * 2, 2), 16);
			}
		} catch {}
	}

	// Per-api capture/replay strategy. \`capture\` converts the native return
	// value into a JSON-serializable blob; \`replay\` reads that blob back and
	// returns the value the wrapper should hand to the site. Returning null
	// from either means "this call isn't an ND event" — pass native through.
	const ND_SPECS = {
		"Math.random":                        { capture: (_a, r) => ({ v: r }),     replay: (_a, d) => d.v },
		"Date.now":                           { capture: (_a, r) => ({ v: r }),     replay: (_a, d) => d.v },
		"Performance.prototype.now":          { capture: (_a, r) => ({ v: r }),     replay: (_a, d) => d.v },
		"Performance.prototype.timeOrigin":   { capture: (_a, r) => ({ v: r }),     replay: (_a, d) => d.v },
		"Crypto.prototype.randomUUID":        { capture: (_a, r) => ({ v: r }),     replay: (_a, d) => d.v },
		"Crypto.prototype.getRandomValues":   {
			capture: (args, _r) => ({ hex: bytesToHex(args[0]) }),
			replay: (args, d) => { writeHexIntoView(args[0], d.hex); return args[0]; },
		},
	};

	// Replay-mode state: FIFO index per api path.
	const ndReplayIdx = {};

	function emitNDRecord(path, data) {
		emit({
			runSeq: ++runSeq, taskSeq: 0, taskId: "nd",
			api: "__scramdiff.nd.record",
			op: "call",
			args: [
				{ t: "string", v: path },
				{ t: "string", v: J_stringify(data) },
			],
			post: { t: "undefined" },
			vtime: A_perf_now ? A_perf_now() : 0,
			internal: true,
			origin: CURRENT_ORIGIN,
		});
	}
	function emitNDDesync(path, reason) {
		emit({
			runSeq: ++runSeq, taskSeq: 0, taskId: "nd",
			api: "__scramdiff.nd.desync",
			op: "call",
			args: [
				{ t: "string", v: path },
				{ t: "string", v: reason },
			],
			post: { t: "undefined" },
			vtime: A_perf_now ? A_perf_now() : 0,
			internal: true,
			origin: CURRENT_ORIGIN,
		});
	}

	/**
	 * Check whether this call should be intercepted by the ND layer. Returns:
	 *   null                     — no ND intervention (observe mode, or callers
	 *                              we always pass through).
	 *   { action: "use-native" } — caller wants native, but we should still
	 *                              capture (record mode) or log desync (replay).
	 *   { action: "replayed",
	 *     result }               — wrapper should return this value without
	 *                              calling native.
	 */
	function ndInterceptApply(path, args, callerIsScramjet, callerIsProbe) {
		if (CONFIG.ndMode === "observe") return null;
		const spec = ND_SPECS[path];
		if (!spec) return null;
		// Scramjet/probe callers always get native — they need real values.
		if (callerIsScramjet || callerIsProbe) return null;
		if (CONFIG.ndMode === "replay") {
			const q = CONFIG.ndCaptures && CONFIG.ndCaptures[path];
			const idx = ndReplayIdx[path] || 0;
			if (!q || idx >= q.length) {
				emitNDDesync(path, q ? "queue-empty" : "no-queue");
				return { action: "use-native" };
			}
			const data = q[idx];
			ndReplayIdx[path] = idx + 1;
			return { action: "replayed", result: spec.replay(args, data) };
		}
		// record mode: caller will invoke native, then we capture the return.
		return { action: "use-native" };
	}
	function ndRecordApply(path, args, result) {
		if (CONFIG.ndMode !== "record") return;
		const spec = ND_SPECS[path];
		if (!spec) return;
		const captured = spec.capture(args, result);
		if (captured == null) return;
		emitNDRecord(path, captured);
	}

	// ---------- breakpoint matching ----------
	// The driver can target a specific per-api (per-op) call: counter-based,
	// indexed across only site-originated traffic so scramjet's own rng/clock
	// calls don't shift the count. When the counter hits the configured index,
	// we emit a __scramdiff.bp.hit event and execute a debugger statement — the
	// driver will have called Debugger.enable on CDP so that statement halts
	// page JS. The driver's Debugger.paused listener surfaces a paused state.
	const BP = CONFIG.breakpoint || null;
	const bpCounts = {};
	function bpMatches(path, op) {
		if (!BP) return false;
		if (BP.api !== path) return false;
		if (BP.op && BP.op !== op) return false;
		const key = path + "|" + op;
		const n = (bpCounts[key] || 0) + 1;
		bpCounts[key] = n;
		return n === BP.matchIndex;
	}
	function emitBPHit(path, op, args, post, pre, self, cs) {
		emit({
			runSeq: ++runSeq, taskSeq: 0, taskId: "bp",
			api: "__scramdiff.bp.hit",
			op: "call",
			args: [
				{ t: "string", v: path },
				{ t: "string", v: op },
				{ t: "string", v: J_stringify(BP) },
			],
			post: { t: "object", ctor: "BPSnapshot",
				summary: J_stringify({
					api: path, op,
					args: args ? args.map(summarizeValue) : undefined,
					post: post !== undefined ? summarizeValue(post) : undefined,
					pre: pre,
					self: self !== undefined ? summarizeValue(self) : undefined,
					scriptUrl: cs && cs.url,
					line: cs && cs.line,
					column: cs && cs.column,
				}).slice(0, 8192),
				hash: ""
			},
			vtime: A_perf_now ? A_perf_now() : 0,
			internal: true,
			origin: CURRENT_ORIGIN,
		});
	}

	// ---------- wrapper installation ----------
	function wrapOperation(ownerObj, key, path, innerFn) {
		// Replace the own-property on the owner with a Proxy-wrapped inner function.
		// We could also build a function-valued Proxy, which is what scramjet does;
		// we mirror that pattern so scramjet's detection heuristics don't trigger
		// on our layer either.
		const handler = {
			apply(target, thisArg, args) {
				if (probeReentry) {
					return R_apply(target, thisArg, args);
				}
				probeReentry = true;
				const cs = analyzeStack();
				// Calls originating from the probe itself (e.g. install() reading
				// performance.now() during setup) would otherwise self-instrument
				// and emit as "real" events. Every stack frame is scramdiff:probe
				// when this happens — drop silently.
				if (cs.callerIsProbe) {
					probeReentry = false;
					return R_apply(target, thisArg, args);
				}
				// Scramjet's interceptor is the immediate caller — this is scramjet
				// calling a native on its own (init housekeeping, or cascading native
				// calls inside one of its own wrappers servicing a user call). Not
				// page-observable; pass through without recording.
				if (CONFIG.harness === "scramjet" && cs.callerIsScramjet) {
					probeReentry = false;
					return R_apply(target, thisArg, args);
				}
				enterTask();
				const ndDec = ndInterceptApply(path, args, cs.callerIsScramjet, cs.callerIsProbe);
				let post, threw = false;
				try {
					probeReentry = false;
					if (ndDec && ndDec.action === "replayed") {
						post = ndDec.result;
					} else {
						post = R_apply(target, thisArg, args);
					}
				} catch (e) {
					post = e; threw = true;
				} finally {
					probeReentry = true;
				}
				// probeReentry is now true; safe to emit record events (emit's
				// serialization path won't re-enter instrumented wrappers).
				if (!threw && ndDec && ndDec.action === "use-native") {
					ndRecordApply(path, args, post);
				}
				let pre;
				if (CONFIG.harness === "scramjet") {
					const r = scramjetNativeCall(path, thisArg, args);
					if (r.have) pre = summarizeValue(r.value);
				}
				if (eventsInCurrentTask++ < CONFIG.maxEventsPerTask) {
					emit({
						runSeq: ++runSeq,
						taskSeq: ++taskSeq,
						taskId: currentTaskId(),
						api: path,
						op: "call",
						args: args.map(summarizeValue),
						post: summarizeValue(post),
						pre,
						self: summarizeValue(thisArg),
						scriptUrl: cs.url,
						line: cs.line,
						column: cs.column,
						vtime: (typeof performance !== "undefined" && performance.now) ? performance.now() : 0,
						internal: false,
						origin: CURRENT_ORIGIN,
					});
				}
				// Breakpoint check — only on site-originated calls (we already
				// dropped probe/scramjet callers above). Emit snapshot + halt.
				if (BP && bpMatches(path, "call")) {
					emitBPHit(path, "call", args, post, pre, thisArg, cs);
					debugger;
				}
				leaveTask();
				probeReentry = false;
				if (threw) throw post;
				return post;
			},
			construct(target, args, newTarget) {
				if (probeReentry) {
					return R_construct(target, args, newTarget);
				}
				probeReentry = true;
				const cs = analyzeStack();
				if (cs.callerIsProbe) {
					probeReentry = false;
					return R_construct(target, args, newTarget);
				}
				if (CONFIG.harness === "scramjet" && cs.callerIsScramjet) {
					probeReentry = false;
					return R_construct(target, args, newTarget);
				}
				enterTask();
				let post, threw = false;
				try {
					probeReentry = false;
					post = R_construct(target, args, newTarget);
				} catch (e) {
					post = e; threw = true;
				} finally {
					probeReentry = true;
				}
				let pre;
				if (CONFIG.harness === "scramjet") {
					const r = scramjetNativeConstruct(path, args);
					if (r.have) pre = summarizeValue(r.value);
				}
				if (eventsInCurrentTask++ < CONFIG.maxEventsPerTask) {
					emit({
						runSeq: ++runSeq,
						taskSeq: ++taskSeq,
						taskId: currentTaskId(),
						api: path,
						op: "construct",
						args: args.map(summarizeValue),
						post: summarizeValue(post),
						pre,
						scriptUrl: cs.url,
						line: cs.line,
						column: cs.column,
						vtime: (typeof performance !== "undefined" && performance.now) ? performance.now() : 0,
						internal: false,
						origin: CURRENT_ORIGIN,
					});
				}
				if (BP && bpMatches(path, "construct")) {
					emitBPHit(path, "construct", args, post, pre, undefined, cs);
					debugger;
				}
				leaveTask();
				probeReentry = false;
				if (threw) throw post;
				return post;
			},
			// Pass through property access on the function itself (Function.prototype.toString, .name, .length, ...)
			// so detection sites that check those don't trip on us.
			get(target, p, recv) { return R_get(target, p, recv); },
		};
		try {
			const wrapped = new Proxy(innerFn, handler);
			const origDesc = O_getOwnPropertyDescriptor(ownerObj, key);
			O_defineProperty(ownerObj, key, {
				value: wrapped,
				writable: origDesc ? !!origDesc.writable : true,
				enumerable: origDesc ? !!origDesc.enumerable : false,
				configurable: origDesc ? !!origDesc.configurable : true,
			});
		} catch (e) {
			// Some members are non-configurable (e.g. Function.prototype on some UAs);
			// skip silently. The differ will note the gap by the absence of events.
		}
	}

	function wrapAttribute(ownerObj, key, path, origDesc) {
		const origGet = origDesc.get;
		const origSet = origDesc.set;
		const newDesc = {
			enumerable: origDesc.enumerable,
			configurable: true,
		};
		if (origGet) {
			newDesc.get = function scramdiffGet() {
				if (probeReentry) {
					return R_apply(origGet, this, []);
				}
				probeReentry = true;
				const cs = analyzeStack();
				if (cs.callerIsProbe) {
					probeReentry = false;
					return R_apply(origGet, this, []);
				}
				if (CONFIG.harness === "scramjet" && cs.callerIsScramjet) {
					probeReentry = false;
					return R_apply(origGet, this, []);
				}
				enterTask();
				const ndDec = ndInterceptApply(path, [], cs.callerIsScramjet, cs.callerIsProbe);
				let post, threw = false;
				try {
					probeReentry = false;
					if (ndDec && ndDec.action === "replayed") {
						post = ndDec.result;
					} else {
						post = R_apply(origGet, this, []);
					}
				} catch (e) {
					post = e; threw = true;
				} finally {
					probeReentry = true;
				}
				if (!threw && ndDec && ndDec.action === "use-native") {
					ndRecordApply(path, [], post);
				}
				let pre;
				if (CONFIG.harness === "scramjet") {
					const r = scramjetNativeGet(path, this);
					if (r.have) pre = summarizeValue(r.value);
				}
				if (eventsInCurrentTask++ < CONFIG.maxEventsPerTask) {
					emit({
						runSeq: ++runSeq,
						taskSeq: ++taskSeq,
						taskId: currentTaskId(),
						api: path,
						op: "get",
						post: summarizeValue(post),
						pre,
						self: summarizeValue(this),
						scriptUrl: cs.url,
						line: cs.line,
						column: cs.column,
						vtime: (typeof performance !== "undefined" && performance.now) ? performance.now() : 0,
						internal: false,
						origin: CURRENT_ORIGIN,
					});
				}
				if (BP && bpMatches(path, "get")) {
					emitBPHit(path, "get", undefined, post, pre, this, cs);
					debugger;
				}
				leaveTask();
				probeReentry = false;
				if (threw) throw post;
				return post;
			};
		}
		if (origSet) {
			newDesc.set = function scramdiffSet(v) {
				if (probeReentry) {
					R_apply(origSet, this, [v]);
					return;
				}
				probeReentry = true;
				const cs = analyzeStack();
				if (cs.callerIsProbe) {
					probeReentry = false;
					R_apply(origSet, this, [v]);
					return;
				}
				if (CONFIG.harness === "scramjet" && cs.callerIsScramjet) {
					probeReentry = false;
					R_apply(origSet, this, [v]);
					return;
				}
				enterTask();
				let threw = false, err;
				try {
					probeReentry = false;
					R_apply(origSet, this, [v]);
				} catch (e) {
					err = e; threw = true;
				} finally {
					probeReentry = true;
				}
				if (eventsInCurrentTask++ < CONFIG.maxEventsPerTask) {
					emit({
						runSeq: ++runSeq,
						taskSeq: ++taskSeq,
						taskId: currentTaskId(),
						api: path,
						op: "set",
						args: [summarizeValue(v)],
						post: threw ? summarizeValue(err) : { t: "undefined" },
						self: summarizeValue(this),
						scriptUrl: cs.url,
						line: cs.line,
						column: cs.column,
						vtime: (typeof performance !== "undefined" && performance.now) ? performance.now() : 0,
						internal: false,
						origin: CURRENT_ORIGIN,
					});
				}
				if (BP && bpMatches(path, "set")) {
					emitBPHit(path, "set", [v], undefined, undefined, this, cs);
					debugger;
				}
				leaveTask();
				probeReentry = false;
				if (threw) throw err;
			};
		}
		try {
			O_defineProperty(ownerObj, key, newDesc);
		} catch {
			// non-configurable; skip.
		}
	}

	// ---------- origin tag ----------
	const CURRENT_ORIGIN = (() => {
		let kind = "window";
		try {
			if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
				if (typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope) kind = "serviceworker";
				else if (typeof SharedWorkerGlobalScope !== "undefined" && globalThis instanceof SharedWorkerGlobalScope) kind = "sharedworker";
				else kind = "worker";
			}
		} catch {}
		let id = "root";
		try {
			if (kind === "window") {
				// Frame tree path: index chain from top.
				const parts = [];
				let w = globalThis;
				while (w.parent && w.parent !== w) {
					try {
						const siblings = w.parent.frames;
						for (let i = 0; i < siblings.length; i++) {
							if (siblings[i] === w) { parts.unshift(i); break; }
						}
					} catch { parts.unshift("?"); }
					w = w.parent;
				}
				id = parts.length ? parts.join("/") : "top";
			}
		} catch {}
		let url = "";
		try { url = String(globalThis.location && globalThis.location.href || ""); } catch {}
		return { kind, id, url };
	})();

	// ---------- install ----------
	function install() {
		const enumFn = new Function("return (" + ${JSON.stringify(ENUMERATE_SRC)} + ")")();
		const { results, errors } = enumFn;
		emit({
			runSeq: ++runSeq, taskSeq: 0, taskId: "init",
			api: "__scramdiff.enumerate",
			op: "call",
			post: { t: "object", ctor: "Enumeration", summary: "count=" + results.length + ",errors=" + errors.length, hash: "" },
			vtime: 0, internal: true, origin: CURRENT_ORIGIN,
			args: [{ t: "object", ctor: "EnumerationDetail", summary: J_stringify({ count: results.length, errors }).slice(0, 4096), hash: "" }],
		});

		for (const m of results) {
			// Resolve the owner object + key for this member.
			let ownerObj = null; let key = null;
			if (m.source === "global") {
				ownerObj = globalThis; key = m.member;
			} else if (m.source === "ctor") {
				const ctor = globalThis[m.interface];
				if (typeof ctor !== "function") continue;
				ownerObj = ctor.prototype; key = m.member;
			} else {
				// instance: walk to find the prototype again by ctor name.
				let found = null;
				try {
					const ctor = globalThis[m.interface];
					if (ctor && ctor.prototype) found = ctor.prototype;
				} catch {}
				// Fallback: walk instance prototype chain until we find the right ctor name.
				if (!found) {
					const seedName = m.source.indexOf("instance:") === 0 ? m.source.slice("instance:".length) : null;
					if (seedName) {
						let inst;
						try { inst = globalThis[seedName]; } catch { continue; }
						if (!inst) continue;
						let p = O_getPrototypeOf(inst);
						while (p && p !== Object.prototype) {
							let cname = null;
							try { cname = p.constructor && p.constructor.name; } catch {}
							if (cname === m.interface) { found = p; break; }
							p = O_getPrototypeOf(p);
						}
					}
				}
				if (!found) continue;
				ownerObj = found; key = m.member;
			}

			// Translate symbol key notation (@@iterator) back to the real symbol.
			if (typeof key === "string" && key.startsWith("@@")) {
				const sym = key.slice(2);
				// Only well-known symbols; ignore registry symbols we can't resolve.
				const wellKnown = ["iterator","asyncIterator","toPrimitive","toStringTag","hasInstance","isConcatSpreadable","match","replace","search","species","split","unscopables"];
				if (wellKnown.indexOf(sym) >= 0 && Symbol[sym]) {
					key = Symbol[sym];
				} else {
					continue;
				}
			}

			let desc;
			try { desc = O_getOwnPropertyDescriptor(ownerObj, key); } catch { continue; }
			if (!desc) continue;

			if (m.kind === "attribute" && (desc.get || desc.set)) {
				wrapAttribute(ownerObj, key, m.path, desc);
			} else if (m.kind === "operation" && typeof desc.value === "function") {
				wrapOperation(ownerObj, key, m.path, desc.value);
			} else if (m.kind === "data" && CONFIG.trackDataProperties) {
				// Turn the data prop into an accessor to track reads/writes.
				const current = { v: desc.value };
				try {
					O_defineProperty(ownerObj, key, {
						enumerable: desc.enumerable,
						configurable: true,
						get: function scramdiffDataGet() {
							enterTask();
							if (eventsInCurrentTask++ < CONFIG.maxEventsPerTask) {
								emit({
									runSeq: ++runSeq, taskSeq: ++taskSeq, taskId: currentTaskId(),
									api: m.path, op: "get",
									post: summarizeValue(current.v),
									self: summarizeValue(this), vtime: 0, internal: false, origin: CURRENT_ORIGIN,
								});
							}
							leaveTask();
							return current.v;
						},
						set: function scramdiffDataSet(v) {
							enterTask();
							current.v = v;
							if (eventsInCurrentTask++ < CONFIG.maxEventsPerTask) {
								emit({
									runSeq: ++runSeq, taskSeq: ++taskSeq, taskId: currentTaskId(),
									api: m.path, op: "set",
									args: [summarizeValue(v)], post: { t: "undefined" },
									self: summarizeValue(this), vtime: 0, internal: false, origin: CURRENT_ORIGIN,
								});
							}
							leaveTask();
						},
					});
				} catch {}
			}
		}

		// ND-extras pass — Math, Date, Performance are excluded from enumerate's
		// ECMA_CORE list (wrapping them blindly causes recursion), but for ND
		// record/replay we do need to intercept a few specific members. Only in
		// record/replay mode; in observe mode the probe leaves them alone so we
		// don't add noise to live-diff runs.
		if (CONFIG.ndMode !== "observe") {
			try {
				const mathDesc = O_getOwnPropertyDescriptor(Math, "random");
				if (mathDesc && typeof mathDesc.value === "function") {
					wrapOperation(Math, "random", "Math.random", mathDesc.value);
				}
			} catch {}
			try {
				const dateDesc = O_getOwnPropertyDescriptor(Date, "now");
				if (dateDesc && typeof dateDesc.value === "function") {
					wrapOperation(Date, "now", "Date.now", dateDesc.value);
				}
			} catch {}
			try {
				if (typeof performance !== "undefined") {
					const perfProto = O_getPrototypeOf(performance);
					if (perfProto) {
						const nowDesc = O_getOwnPropertyDescriptor(perfProto, "now");
						if (nowDesc && typeof nowDesc.value === "function") {
							wrapOperation(perfProto, "now", "Performance.prototype.now", nowDesc.value);
						}
						const toDesc = O_getOwnPropertyDescriptor(perfProto, "timeOrigin");
						if (toDesc && (toDesc.get || toDesc.set)) {
							wrapAttribute(perfProto, "timeOrigin", "Performance.prototype.timeOrigin", toDesc);
						}
					}
				}
			} catch {}
		}

		// Heartbeat — tells the driver the probe is fully installed.
		emit({
			runSeq: ++runSeq, taskSeq: 0, taskId: "init",
			api: "__scramdiff.installed",
			op: "call",
			post: { t: "primitive", v: results.length },
			vtime: (typeof performance !== "undefined" && performance.now) ? performance.now() : 0,
			internal: true, origin: CURRENT_ORIGIN,
		});
	}

	// Wait for scramjet (if present) to have installed its interceptors so our
	// wrappers sit OUTSIDE scramjet's. Strategy: if SCRAMJETCLIENT exists after
	// yielding a microtask, it's already installed. Otherwise poll up to a
	// timeout — a page without scramjet will never set the symbol, so we
	// fall through to the direct-run install on timeout.
	let waitDeadline = Date.now() + 2000;
	function checkAndInstall() {
		const hasScramjet = SCRAMJETCLIENT in globalThis;
		if (CONFIG.harness === "scramjet") {
			if (hasScramjet) {
				// Give scramjet one more microtask to finish its module hook loop.
				P_resolve().then(install);
				return;
			}
			if (Date.now() < waitDeadline) {
				P_resolve().then(checkAndInstall);
				return;
			}
			// scramjet was expected but never appeared — install anyway so we produce something.
			install();
		} else {
			// direct harness: no scramjet expected. Install now.
			install();
		}
	}
	checkAndInstall();
})();
//# sourceURL=scramdiff:probe
`;
}
