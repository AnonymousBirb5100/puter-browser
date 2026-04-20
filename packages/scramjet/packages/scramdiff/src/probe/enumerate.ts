/**
 * Runtime Web API enumeration.
 *
 * Emitted as a JS string and injected via CDP `Page.addScriptToEvaluateOnNewDocument`.
 * Returns the full list of (interface, member) tuples reachable from the global,
 * which the probe then wraps without opinion about whether scramjet happens to
 * intercept each one — the whole point is to catch interceptors scramjet is
 * missing, which is exactly the set you can't hardcode.
 *
 * Enumeration strategy:
 *   1. Every own-property of the global whose value is a function with a .prototype.
 *      (Gets us Document, Element, Window, XMLHttpRequest, ..., every IDL interface
 *       the browser ships to this global.)
 *   2. Every prototype reachable via the prototype chain of a known instance property
 *      (document, navigator, location, history, performance, screen, ...). This
 *      catches interfaces like Location or WorkerLocation that aren't exposed as
 *      constructors in every context.
 *   3. Every own-property of the global itself that is callable — top-level
 *      operations like fetch, setTimeout, eval, open, btoa.
 *   4. Every own-property of the global that is a non-callable value and whose
 *      descriptor has a getter/setter — top-level attributes like crossOriginIsolated,
 *      isSecureContext, origin.
 *
 * Property descriptors are the source of truth for "attribute vs operation":
 *   - desc.get or desc.set          → attribute (trap as get/set)
 *   - typeof desc.value === function → operation (wrap as apply/construct)
 *   - else                          → data property; trap get/set to track mutation
 *
 * All reads are defensive: any access on globals can throw (crossOriginIsolated,
 * sharedStorage feature-gated, WebAssembly in non-secure contexts, etc.). A throw
 * during enumeration is itself information — the caller records it.
 */

export const ENUMERATE_SRC = /* js */ `
(() => {
	"use strict";
	const results = [];
	const errors = [];
	const visited = new WeakSet();
	const g = globalThis;

	// Cache natives we rely on so the probe works even if scramjet hasn't
	// finished installing yet (or if a page overwrites them).
	const O_getOwnPropertyNames = Object.getOwnPropertyNames;
	const O_getOwnPropertySymbols = Object.getOwnPropertySymbols;
	const O_getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	const O_getPrototypeOf = Object.getPrototypeOf;
	const Symbol_keyFor = Symbol.keyFor;

	// ECMAScript core: not web-IDL, not the interception surface scramjet cares
	// about. Wrapping Object/Function/Error/Array/String/etc. methods causes
	// infinite recursion (our own emit/callSite path uses them) and interferes
	// with scramjet's own bootstrap. The oracle is an interceptor oracle —
	// scramjet doesn't intercept ECMAScript built-ins, so we don't need to.
	const ECMA_CORE = new Set([
		"Object", "Function", "Array", "Number", "String", "Boolean", "Symbol", "BigInt",
		"Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError",
		"URIError", "AggregateError", "InternalError",
		"Date", "RegExp",
		"Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry",
		"Promise", "Generator", "GeneratorFunction", "AsyncFunction", "AsyncGenerator",
		"AsyncGeneratorFunction", "Iterator", "AsyncIterator",
		"JSON", "Math", "Reflect", "Proxy", "Intl", "Atomics",
		"ArrayBuffer", "SharedArrayBuffer", "DataView",
		"Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
		"Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array",
		"Float16Array", "Float32Array", "Float64Array",
		"encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
		"isFinite", "isNaN", "parseInt", "parseFloat", "eval",
		"undefined", "NaN", "Infinity", "globalThis",
	]);
	// Also skip the root prototypes directly — walking into these wraps toString,
	// hasOwnProperty, valueOf, apply, call, bind, etc., which everything uses.
	const ECMA_CORE_PROTOS = new WeakSet();
	try { ECMA_CORE_PROTOS.add(Object.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Function.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Array.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(String.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Number.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Boolean.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Error.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Symbol.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(RegExp.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Date.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Promise.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Map.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(Set.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(WeakMap.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(WeakSet.prototype); } catch {}
	try { ECMA_CORE_PROTOS.add(ArrayBuffer.prototype); } catch {}

	function describeKey(key) {
		if (typeof key === "symbol") {
			const sKey = Symbol_keyFor(key);
			if (sKey !== undefined) return "@@" + sKey;
			return "@@" + String(key).replace(/^Symbol\\(|\\)$/g, "");
		}
		return String(key);
	}

	function interfaceNameOf(proto) {
		try {
			const ctor = proto.constructor;
			if (ctor && typeof ctor === "function" && typeof ctor.name === "string" && ctor.name) {
				return ctor.name;
			}
		} catch {}
		// Fall back to the toString tag.
		try {
			const tag = proto[Symbol.toStringTag];
			if (typeof tag === "string" && tag) return tag;
		} catch {}
		return "Anonymous";
	}

	function enumerateProto(proto, iname, source) {
		if (!proto || visited.has(proto)) return;
		if (ECMA_CORE_PROTOS.has(proto)) return;
		if (isPerformanceInterfaceName(iname)) return;
		visited.add(proto);

		let ownKeys;
		try {
			ownKeys = O_getOwnPropertyNames(proto).concat(O_getOwnPropertySymbols(proto));
		} catch (e) {
			errors.push({ where: iname + " (getOwnKeys)", message: String(e && e.message || e) });
			return;
		}

		for (const key of ownKeys) {
			if (key === "constructor") continue;
			// Window.prototype.performance (and WorkerGlobalScope.prototype.performance,
			// etc.) — catch it here even though we already skipped the Performance*
			// interfaces themselves, since the entry point is on Window, not Performance.
			if (isPerformanceMemberKey(key)) continue;
			let desc;
			try {
				desc = O_getOwnPropertyDescriptor(proto, key);
			} catch (e) {
				errors.push({ where: iname + "." + describeKey(key), message: String(e && e.message || e) });
				continue;
			}
			if (!desc) continue;

			const memberKey = describeKey(key);
			const path = iname + ".prototype." + memberKey;

			if (desc.get || desc.set) {
				results.push({
					path,
					interface: iname,
					member: memberKey,
					kind: "attribute",
					hasGet: !!desc.get,
					hasSet: !!desc.set,
					enumerable: !!desc.enumerable,
					configurable: !!desc.configurable,
					source,
				});
			} else if (typeof desc.value === "function") {
				// Could be a regular method, a constructor-style callable, or an internal slot.
				let isConstructor = false;
				try {
					isConstructor = typeof desc.value.prototype === "object" && desc.value.prototype !== null;
				} catch {}
				results.push({
					path,
					interface: iname,
					member: memberKey,
					kind: "operation",
					length: (typeof desc.value.length === "number") ? desc.value.length : 0,
					constructorCallable: isConstructor,
					enumerable: !!desc.enumerable,
					configurable: !!desc.configurable,
					source,
				});
			} else {
				// Data property on prototype — rare but exists (e.g. Element.prototype.nodeType is typically a getter,
				// but some UAs use data props). Track as attribute to catch mutation.
				results.push({
					path,
					interface: iname,
					member: memberKey,
					kind: "data",
					enumerable: !!desc.enumerable,
					configurable: !!desc.configurable,
					source,
				});
			}
		}

		// Walk further up the chain.
		let parent = null;
		try { parent = O_getPrototypeOf(proto); } catch {}
		if (parent && parent !== Object.prototype && parent !== null) {
			enumerateProto(parent, interfaceNameOf(parent), source);
		}
	}

	// Scramdiff's own instrumentation installs global names like __scramdiffEmit
	// (the CDP binding injected by the driver), __scramdiffProbeInstalled (set by
	// the probe IIFE), and __scramdiffHarnessReady/__scramdiffEncode (from the
	// harness bootstrap). None of these are page APIs and wrapping them would
	// turn our own plumbing into diff noise.
	function isScramdiffInternal(key) {
		return typeof key === "string" && key.indexOf("__scramdiff") === 0;
	}

	// Performance observation APIs — timing measurements that are
	// nondeterministic by design. Two runs of the same page against different
	// network paths (direct vs through scramjet's SW+wisp transport) will
	// necessarily differ in every timing field: navigationStart, responseEnd,
	// encodedBodySize (scramjet injects its client bundle), clientHeight
	// (iframe vs top), etc. Scramjet cannot realistically proxy these to
	// match, and diffing them produces pure noise that drowns out real bugs.
	// Skip at enumeration time so the probe never wraps them.
	//
	// Matches: Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure,
	// PerformanceObserver, PerformanceObserverEntryList, PerformanceNavigation,
	// PerformanceNavigationTiming, PerformancePaintTiming, PerformanceResourceTiming,
	// PerformanceServerTiming, PerformanceTiming, PerformanceEventTiming,
	// PerformanceLongTaskTiming, PerformanceElementTiming, PerformanceScriptTiming,
	// plus the adjacent timing types: LayoutShift(Attribution),
	// LargestContentfulPaint, TaskAttributionTiming, EventCounts.
	function isPerformanceInterfaceName(name) {
		if (typeof name !== "string") return false;
		if (name.indexOf("Performance") === 0) return true;
		if (name === "LayoutShift" || name === "LayoutShiftAttribution") return true;
		if (name === "LargestContentfulPaint") return true;
		if (name === "TaskAttributionTiming") return true;
		if (name === "EventCounts") return true;
		return false;
	}
	// Matches the \`performance\` attribute wherever it appears — on the global,
	// on Window.prototype, on WorkerGlobalScope.prototype, etc.
	function isPerformanceMemberKey(key) {
		return key === "performance";
	}

	// (1) Every own-property of the global that looks like a Web IDL interface.
	let globalKeys;
	try { globalKeys = O_getOwnPropertyNames(g); } catch (e) {
		errors.push({ where: "global", message: String(e && e.message || e) });
		globalKeys = [];
	}
	for (const key of globalKeys) {
		if (ECMA_CORE.has(key)) continue;
		if (isScramdiffInternal(key)) continue;
		if (isPerformanceInterfaceName(key)) continue;
		let val;
		try { val = g[key]; } catch (e) {
			errors.push({ where: "global." + key, message: String(e && e.message || e) });
			continue;
		}
		if (typeof val !== "function") continue;
		let proto;
		try { proto = val.prototype; } catch { proto = null; }
		if (!proto || typeof proto !== "object") continue;
		enumerateProto(proto, key, "ctor");
	}

	// (2) Instance-reachable prototypes that aren't always exposed as constructors.
	// NB: "performance" intentionally omitted — see isPerformanceInterfaceName.
	const instanceSeeds = [
		"document", "navigator", "location", "history", "screen",
		"localStorage", "sessionStorage", "crypto", "indexedDB", "caches",
		"speechSynthesis", "visualViewport", "chrome"
	];
	for (const name of instanceSeeds) {
		let inst;
		try { inst = g[name]; } catch { continue; }
		if (inst === null || (typeof inst !== "object" && typeof inst !== "function")) continue;
		let proto;
		try { proto = O_getPrototypeOf(inst); } catch { continue; }
		if (!proto) continue;
		enumerateProto(proto, interfaceNameOf(proto), "instance:" + name);
	}

	// Also the global itself — for the Window.prototype chain specifically, we walk
	// from \`window\` when available (the prototype chain is window → Window → WindowProperties → EventTarget → Object).
	try {
		if (typeof g === "object" && g !== null) {
			enumerateProto(O_getPrototypeOf(g), interfaceNameOf(O_getPrototypeOf(g)), "globalProto");
		}
	} catch {}

	// (3 + 4) Top-level operations and attributes on the global itself (fetch, setTimeout, eval,
	// origin, crossOriginIsolated, ...).
	for (const key of globalKeys) {
		if (ECMA_CORE.has(key)) continue;
		if (isScramdiffInternal(key)) continue;
		// Skip globalThis.performance and the Performance* constructors at the
		// top-level attribute walk too (the ctor walk above skips them, but the
		// attribute walk is a separate pass over the same keys).
		if (isPerformanceInterfaceName(key) || isPerformanceMemberKey(key)) continue;
		let desc;
		try { desc = O_getOwnPropertyDescriptor(g, key); } catch (e) {
			errors.push({ where: "globalOwn." + key, message: String(e && e.message || e) });
			continue;
		}
		if (!desc) continue;

		// Skip interface constructors themselves (already handled via their prototype).
		// They have .prototype; we still want to wrap the constructor call itself though,
		// so record as operation when callable.
		if (desc.get || desc.set) {
			results.push({
				path: "globalThis." + key,
				interface: "globalThis",
				member: key,
				kind: "attribute",
				hasGet: !!desc.get,
				hasSet: !!desc.set,
				enumerable: !!desc.enumerable,
				configurable: !!desc.configurable,
				source: "global",
			});
		} else if (typeof desc.value === "function") {
			let isConstructor = false;
			try {
				isConstructor = typeof desc.value.prototype === "object" && desc.value.prototype !== null;
			} catch {}
			results.push({
				path: "globalThis." + key,
				interface: "globalThis",
				member: key,
				kind: "operation",
				length: (typeof desc.value.length === "number") ? desc.value.length : 0,
				constructorCallable: isConstructor,
				enumerable: !!desc.enumerable,
				configurable: !!desc.configurable,
				source: "global",
			});
		}
		// Plain data (numbers, strings, NaN, undefined) on the global are ignored — nothing to intercept.
	}

	return { results, errors };
})()
`;

/**
 * Describes a wrappable API member as returned by the enumerator above.
 * Kept in sync with the shape the in-page enumerator produces.
 */
export type EnumeratedMember = {
	path: string;
	interface: string;
	member: string;
	kind: "attribute" | "operation" | "data";
	hasGet?: boolean;
	hasSet?: boolean;
	length?: number;
	constructorCallable?: boolean;
	enumerable: boolean;
	configurable: boolean;
	source: string;
};

export type EnumerationResult = {
	results: EnumeratedMember[];
	errors: Array<{ where: string; message: string }>;
};
