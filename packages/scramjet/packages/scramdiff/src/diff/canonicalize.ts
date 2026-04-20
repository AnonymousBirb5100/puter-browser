/**
 * "Canonicalization" for scramdiff is deliberately minimal.
 *
 * The page observes `post` values. If scramjet returned a proxy-rewritten URL
 * to the page, the page saw a proxy URL — that IS the bug we're hunting. So
 * the comparison is literal: scramjet.post must equal direct.post. We do NOT
 * run scramjet's own unrewrite functions over post values before diffing; that
 * would mask exactly the leaks the oracle exists to find.
 *
 * The only transforms applied here suppress legitimate, non-bug
 * nondeterminism that survives V8's predictable mode:
 *
 *   - Frame ids, realm ids, and other opaque handles the browser might mint
 *     per-context: these appear in `origin.id`. We compare structurally
 *     (same kind + same frame path) rather than by the opaque id itself.
 *
 *   - Global-singleton object hashes (Window, Document, Location, Navigator…).
 *     The probe fingerprints objects by djb2 of their first-8-own-props, which
 *     is stable for plain page objects but arbitrary for a Window with hundreds
 *     of own-props mutating across a page lifecycle. `canonicalizeRun` rewrites
 *     singleton hashes in-place to creation-order ordinals (`ord:0`, `ord:1`…)
 *     within each run, so "direct's first Window" matches "scramjet's first
 *     Window" even though their raw hashes differ — while still catching the
 *     real bug of scramjet handing back the wrong singleton for a given call.
 *     See GLOBAL_SINGLETON_CTORS below.
 *
 * That's it. Everything else is a literal string compare on the value JS saw.
 */

import type { TraceEvent, TraceValue } from "../trace.ts";

/**
 * Ctor names for "global singletons" — objects that exist once per browsing
 * context and whose observable state is inherently tied to that context.
 *
 * The probe's summarizeValue() fingerprints these by a djb2 hash of their
 * first 8 own-properties, which is arbitrary for a Window-like object with
 * hundreds of own-props that accumulate in insertion order as scripts mutate
 * the global. Two runs of the same page produce different hashes (scramjet-
 * injected properties, page-code-added properties landing at different times,
 * Playwright injecting its own bindings) — none of which are bugs in scramjet.
 *
 * But "opaque, match by ctor only" throws away a real signal: if direct
 * returns the top-level Window and scramjet returns some *other* Window
 * (wrong frame's global, a stale handle, the harness's own window), the
 * ctors match and the divergence is silently swallowed.
 *
 * Instead we use RELATIVE identity: assign each distinct singleton object an
 * ordinal in the order it first appears in the run's event stream. The first
 * Window seen is #0, the second distinct Window is #1, etc. — assigned
 * independently per run. Cross-run comparison then matches "direct's #0
 * Window" against "scramjet's #0 Window", "direct's #1 Window" against
 * "scramjet's #1 Window", and so on. Absolute hashes diverge (fine); relative
 * order diverges only when scramjet genuinely exposed the wrong singleton.
 *
 * Real scramjet leaks still show up as events: reading window.fetch,
 * document.cookie, location.href, navigator.userAgent each generate their
 * own API events which DO diff on their observed values.
 */
export const GLOBAL_SINGLETON_CTORS = new Set<string>([
	// Window family
	"Window",
	"WindowProxy",
	"DOMWindow",
	// Document family
	"Document",
	"HTMLDocument",
	"XMLDocument",
	// Core globals
	"Location",
	"WorkerLocation",
	"Navigator",
	"WorkerNavigator",
	"History",
	"Screen",
	"VisualViewport",
	// Storage-ish singletons
	"Storage",
	"IDBFactory",
	"CacheStorage",
	"CookieStore",
	// Feature singletons on Navigator / Window
	"Crypto",
	"SubtleCrypto",
	"CustomElementRegistry",
	"FontFaceSet",
	"Clipboard",
	"Permissions",
	"MediaDevices",
	"Scheduler",
	"NetworkInformation",
	"Geolocation",
	"SpeechSynthesis",
	"LaunchQueue",
	"BarProp", // locationbar, menubar, personalbar, etc.
]);

/**
 * Build a stateful ordinal assigner per ctor. First distinct hash for ctor
 * "Window" gets ordinal 0, second gets 1, etc. Returns the ordinal token to
 * substitute into the value's `hash` field.
 */
function makeOrdinalAssigner(): (ctor: string, hash: string) => string {
	const perCtor = new Map<string, Map<string, number>>();
	return (ctor: string, hash: string) => {
		let m = perCtor.get(ctor);
		if (!m) {
			m = new Map();
			perCtor.set(ctor, m);
		}
		let n = m.get(hash);
		if (n === undefined) {
			n = m.size;
			m.set(hash, n);
		}
		return `ord:${n}`;
	};
}

function canonicalizeValue(
	v: TraceValue | undefined,
	ordinalFor: (ctor: string, hash: string) => string
): void {
	if (!v) return;
	if (v.t === "object" && GLOBAL_SINGLETON_CTORS.has(v.ctor)) {
		v.hash = ordinalFor(v.ctor, v.hash);
	}
}

/**
 * Rewrite singleton-object hashes to creation-order ordinals, in place.
 *
 * Each origin in the run gets its own ordinal namespace — a worker's Window
 * and the main document's Window shouldn't collide just because they both
 * hit ordinal 0 in their respective streams, and since `diffRuns` matches
 * origins independently (worker ↔ worker, window ↔ window) per-origin spaces
 * are what the differ expects.
 *
 * Must be called on each run's traces before diff. After this runs, the
 * existing `A.hash === B.hash` check in `valuesEqual` does the right thing
 * for singletons; no special-casing needed downstream.
 */
export function canonicalizeRun(traces: Record<string, TraceEvent[]>): void {
	for (const events of Object.values(traces)) {
		const ordinalFor = makeOrdinalAssigner();
		// Walk in runSeq order so first-seen ordering is deterministic regardless
		// of how the origin bucket was populated. coalesceTraces already sorts
		// window:target by runSeq; other buckets we sort defensively.
		const sorted = [...events].sort((a, b) => a.runSeq - b.runSeq);
		for (const ev of sorted) {
			canonicalizeValue(ev.post, ordinalFor);
			canonicalizeValue(ev.pre, ordinalFor);
			canonicalizeValue(ev.self, ordinalFor);
			if (ev.args) for (const a of ev.args) canonicalizeValue(a, ordinalFor);
		}
	}
}

/** Strict structural equality on the value JS observed. No rewriting. */
export function valuesEqual(a: TraceValue, b: TraceValue): boolean {
	if (a.t !== b.t) return false;
	switch (a.t) {
		case "undefined":
			return true;
		case "primitive": {
			const A = a as Extract<TraceValue, { t: "primitive" }>;
			const B = b as Extract<TraceValue, { t: "primitive" }>;
			// NaN-safe: both serialize as null through the probe's stringifier,
			// so a literal === compare works for all primitive values that reach here.
			return A.v === B.v;
		}
		case "string": {
			const A = a as Extract<TraceValue, { t: "string" }>;
			const B = b as Extract<TraceValue, { t: "string" }>;
			return A.v === B.v;
		}
		case "bigint":
		case "symbol": {
			const A = a as any;
			const B = b as any;
			return A.v === B.v;
		}
		case "function": {
			const A = a as Extract<TraceValue, { t: "function" }>;
			const B = b as Extract<TraceValue, { t: "function" }>;
			return A.name === B.name && A.length === B.length;
		}
		case "object":
		case "array": {
			const A = a as any;
			const B = b as any;
			if (A.ctor !== B.ctor) return false;
			// For singletons, `hash` has been rewritten to an `ord:N` ordinal
			// by canonicalizeRun; for non-singleton objects it's the raw djb2
			// fingerprint. Either way a literal hash compare is correct.
			if (A.hash && B.hash) return A.hash === B.hash;
			return A.summary === B.summary;
		}
		case "dom": {
			const A = a as Extract<TraceValue, { t: "dom" }>;
			const B = b as Extract<TraceValue, { t: "dom" }>;
			return A.ctor === B.ctor && A.desc === B.desc;
		}
		case "error": {
			const A = a as Extract<TraceValue, { t: "error" }>;
			const B = b as Extract<TraceValue, { t: "error" }>;
			return A.name === B.name && A.message === B.message;
		}
		case "unserializable": {
			// Two unserializable values are considered equivalent if they failed the
			// same way — otherwise flag for human review.
			const A = a as Extract<TraceValue, { t: "unserializable" }>;
			const B = b as Extract<TraceValue, { t: "unserializable" }>;
			return A.reason === B.reason;
		}
		default:
			return false;
	}
}

/**
 * Structural origin equality. Two events can be matched across runs when
 * their origins share kind + frame path, ignoring any opaque browser-minted id.
 */
export function originsEqual(
	a: TraceEvent["origin"],
	b: TraceEvent["origin"]
): boolean {
	if (a.kind !== b.kind) return false;
	if (a.id !== b.id) return false;
	return true;
}
