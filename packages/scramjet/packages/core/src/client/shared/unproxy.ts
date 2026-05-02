import { ProxyCtx, ScramjetClient } from "@client/client";
import { SCRAMJETCLIENT } from "@/symbols";
import {
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	Reflect_apply,
	Reflect_get,
	Reflect_has,
} from "@/shared/snapshot";
import {
	OPERATIONS,
	ATTRIBUTES,
	type ArgSelector,
	type ProxyKind,
} from "../unproxy.generated";

/**
 * Maps each fast-path wrapper function back to the native function it
 * stands in for, so `Function.prototype.toString` interception
 * (sourcemaps.ts) can return the original native source string and avoid
 * leaking our wrapper's body to anti-tampering checks. Module-level so
 * it survives across module loads and is shared with sourcemaps.ts.
 */
export const NATIVE_BACKING: WeakMap<AnyFunction, AnyFunction> = new WeakMap();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;

// we don't want to end up overriding a property on window that's derived from a prototype until we've proxied the prototype
export const order = 3;

/**
 * If `v` is one of our document/global proxies (in this client OR any nested
 * scramjet client) replace it with the underlying real Window/Document. Native
 * code rejects our Proxy objects with an "Illegal invocation" otherwise.
 */
function unproxyValue(v: any, client: ScramjetClient): any {
	if (v == null) return v;
	if (v === client.globalProxy) return client.global;
	if (v === client.documentProxy) return client.global.document;
	return v;
}

/**
 * If `v` is a real Window/Document with a known scramjet client, return that
 * client's proxy. Otherwise return the value untouched. Used to wrap return
 * values of APIs that return Window/Document so user code keeps seeing the
 * proxy view of the world.
 */
function proxyValue(v: any, kind: ProxyKind, client: ScramjetClient): any {
	if (v == null) return v;
	// If we're not in PPSC mode, no proxies exist; pass values through.
	if (!client.globalProxy) return v;

	// Direct hit on this realm. Document branch is gated on documentProxy
	// because ScramjetFlags.disableDocumentProxy leaves it null.
	if (v === client.global) return client.globalProxy;
	if (client.documentProxy && v === client.global.document)
		return client.documentProxy;

	// Cross-realm: probe the proxy stash on the value (or its window for
	// documents). Wrap in try/catch because cross-origin access throws.
	try {
		if (kind !== "d") {
			// "w" or "*": maybe a Window
			const c = (v as any)[SCRAMJETCLIENT];
			if (c && c.globalProxy && v === c.global) return c.globalProxy;
		}
		if (kind !== "w") {
			// "d" or "*": maybe a Document
			const c = (v as any)[SCRAMJETCLIENT];
			if (c && c.documentProxy && v === c.global.document)
				return c.documentProxy;
		}
	} catch {}

	return v;
}

/**
 * Apply each ArgSelector against an argument list, replacing the targeted
 * value with its un-proxied form. Selectors with extra path components walk
 * into the argument (used for dictionary args, e.g. options.root).
 */
function unproxyArgs(
	args: any[],
	selectors: readonly ArgSelector[],
	client: ScramjetClient
) {
	for (const sel of selectors) {
		const argIdx = sel[0];
		// sel = [argIdx, kind, ...path]; kind ("w"/"d") at sel[1] is informational
		// only — unproxyValue handles both kinds.
		const path = sel.length > 2 ? sel.slice(2) : null;

		if (!path) {
			args[argIdx] = unproxyValue(args[argIdx], client);
			continue;
		}

		let obj = args[argIdx];
		for (let i = 0; i < path.length - 1; i++) {
			if (obj == null) break;
			obj = obj[path[i] as string];
		}
		if (obj == null) continue;
		const last = path[path.length - 1] as string;
		obj[last] = unproxyValue(obj[last], client);
	}
}

// Members of these IDL interfaces don't actually live on `Owner.prototype`
// at runtime -- engines install them as own properties of the global object
// (Window) or of the worker global scope (`self`). RawProxy on the prototype
// would either no-op or fail Reflect.has, so we redirect those installs to
// `self`. Also matches the original hand-rolled `for (const target of [self])`
// sweep.
const GLOBAL_OWNERS = new Set<string>([
	"Window",
	"WorkerGlobalScope",
	"DedicatedWorkerGlobalScope",
	"SharedWorkerGlobalScope",
	"ServiceWorkerGlobalScope",
]);

// Owners whose runtime instances might be `this` for a method call -- i.e.
// the apply hook on their prototype must always run to swap the proxy back
// to the real platform object. Window IS-A EventTarget, so EventTarget is
// always required (otherwise `globalProxy.addEventListener(...)` lands in
// native code with `this === globalProxy` and trips Illegal invocation).
// Document/Node are only required when the documentProxy actually exists.
function ownerNeedsThisUnproxy(owner: string, haveDocProxy: boolean): boolean {
	if (GLOBAL_OWNERS.has(owner)) return true;
	if (owner === "EventTarget") return true;
	if (haveDocProxy && (owner === "Document" || owner === "Node")) return true;
	return false;
}

/**
 * Fast install for the common case: the only thing the apply hook would
 * have done is swap `this` from the global/document proxy back to the real
 * platform object. We replace the prototype property with a plain function
 * instead of `new Proxy(value, h)`. That avoids:
 *   - the `Proxy[[Apply]]` trap (V8 slow path; defeats inline-cache)
 *   - the per-call `ctx` object allocation in `RawProxy`
 *   - the per-call `Error.prepareStackTrace` save/swap/restore dance
 *   - the `try { handler.apply(ctx) } catch (...)` overhead
 *
 * Returns true if the install succeeded; the caller falls back to RawProxy
 * if not.
 */
function installThisSwap(
	target: any,
	prop: string,
	client: ScramjetClient
): boolean {
	if (!target || !prop) return false;
	if (!Reflect_has(target, prop)) return false;
	const native = Reflect_get(target, prop) as AnyFunction;
	if (typeof native !== "function") return false;

	const desc = Object_getOwnPropertyDescriptor(target, prop);
	const gProxy = client.globalProxy as any;
	const dProxy = client.documentProxy as any;
	const gReal = client.global as any;
	const dReal = (client.global as any).document;

	// Pick the smallest-arity wrapper based on which proxies actually exist
	// at install time. The closure capture means the comparisons constant-fold
	// for V8's inline cache: each wrapper has exactly the branches it needs.
	let wrapper: AnyFunction;
	if (gProxy && dProxy) {
		wrapper = function (this: any) {
			return Reflect_apply(
				native,
				this === gProxy ? gReal : this === dProxy ? dReal : this,
				arguments as any
			);
		};
	} else if (gProxy) {
		wrapper = function (this: any) {
			return Reflect_apply(
				native,
				this === gProxy ? gReal : this,
				arguments as any
			);
		};
	} else if (dProxy) {
		wrapper = function (this: any) {
			return Reflect_apply(
				native,
				this === dProxy ? dReal : this,
				arguments as any
			);
		};
	} else {
		// Neither proxy exists -- there's literally nothing for this hook to
		// do. Tell the caller to skip the install entirely.
		return false;
	}

	// Match the native function's name (some libraries detect by `.name`).
	try {
		Object_defineProperty(wrapper, "name", {
			value: (native as any).name ?? prop,
			configurable: true,
		});
	} catch {}

	// Anti-tampering checks read `func.toString()`. Cache the native's
	// toString output once and shadow Function.prototype.toString on the
	// wrapper itself. Function.prototype.toString.call(wrapper) will still
	// see the wrapper source, but sourcemaps.ts's toString proxy consults
	// NATIVE_BACKING below to recover the native string in that path too.
	let nativeStr: string | null = null;
	try {
		nativeStr = (native as any).toString();
	} catch {}
	if (nativeStr !== null) {
		try {
			Object_defineProperty(wrapper, "toString", {
				value: function () {
					return nativeStr;
				},
				configurable: true,
				writable: true,
			});
		} catch {}
	}

	NATIVE_BACKING.set(wrapper, native);

	delete target[prop];
	Object_defineProperty(target, prop, {
		value: wrapper,
		writable: desc?.writable ?? true,
		enumerable: desc?.enumerable ?? false,
		configurable: desc?.configurable ?? true,
	});

	return true;
}

export const enabled = (c: ScramjetClient) => c.visitor === "ppsc";
export default function (client: ScramjetClient, self: typeof window) {
	// `disableDocumentProxy` leaves documentProxy null. In that mode we skip
	// every entry that exists solely for the document-proxy half of PPSC --
	// "d"-kind args, "d" return wrap, "d" attributes -- because user code
	// never sees a documentProxy.
	const haveDocProxy = !!client.documentProxy;

	// --- IDL-driven operation/constructor patches ---------------------------
	for (const [
		owner,
		member,
		isStatic,
		isCtor,
		argSelectors,
		returnKind,
	] of OPERATIONS) {
		const ctor = (self as any)[owner];
		if (!ctor) continue;

		// When document proxy is disabled, narrow the work this entry
		// describes. Drop "d"-kind selectors and any "d" return wrap. "*"
		// returns stay (proxyValue is null-safe for the document branch).
		const activeArgs = haveDocProxy
			? argSelectors
			: argSelectors.filter((s) => s[1] !== "d");
		const activeReturnKind: ProxyKind | "" =
			!haveDocProxy && returnKind === "d" ? "" : returnKind;

		// Skip the install entirely if there's no concrete work AND no proxy
		// could land here as `this`. Otherwise even a "no-op" hook is needed
		// just so we can swap a proxy receiver back to the real object.
		if (
			activeArgs.length === 0 &&
			!activeReturnKind &&
			!ownerNeedsThisUnproxy(owner, haveDocProxy)
		) {
			continue;
		}

		if (isCtor) {
			if (activeArgs.length === 0) continue;
			client.RawProxy(
				self,
				owner,
				{
					construct(ctx) {
						unproxyArgs(ctx.args as any[], activeArgs, client);
					},
				},
				`${owner} constructor`
			);
			continue;
		}

		const target = isStatic
			? ctor
			: GLOBAL_OWNERS.has(owner)
				? self
				: ctor.prototype;
		if (!target) continue;

		const wrapsArgs = activeArgs.length > 0;
		const wrapsReturn = !!activeReturnKind;

		// Fast path: the entry only exists to swap `this`. Skip the full
		// RawProxy machinery -- install a plain function instead. Avoids
		// Proxy[[Apply]], ctx allocation, and the prepareStackTrace dance
		// per call. Roughly 80% of OPERATIONS land here in PPSC mode.
		if (!wrapsArgs && !wrapsReturn) {
			installThisSwap(target, member, client);
			continue;
		}

		client.RawProxy(
			target,
			member,
			{
				apply(ctx) {
					// Always normalize `this` so passing the global/document proxy
					// in as the receiver doesn't trip "Illegal invocation".
					if (ctx.this === client.globalProxy) ctx.this = self as any;
					else if (client.documentProxy && ctx.this === client.documentProxy)
						ctx.this = self.document as any;

					if (wrapsArgs) unproxyArgs(ctx.args as any[], activeArgs, client);

					if (wrapsReturn) {
						const result = ctx.call();
						ctx.return(
							proxyValue(result, activeReturnKind as ProxyKind, client)
						);
					}
				},
			},
			`${owner}${isStatic || GLOBAL_OWNERS.has(owner) ? "" : ".prototype"}.${member}`
		);
	}

	// --- IDL-driven attribute traps -----------------------------------------
	for (const [owner, member, isStatic, kind, readonly] of ATTRIBUTES) {
		// "d" attrs only matter when there's a documentProxy to wrap into.
		if (!haveDocProxy && kind === "d") continue;
		const ctor = (self as any)[owner];
		if (!ctor) continue;
		const target = isStatic ? ctor : ctor.prototype;
		if (!target) continue;

		const trap: {
			get?: (ctx: any) => any;
			set?: (ctx: any, v: any) => void;
		} = {
			get(ctx) {
				const v = ctx.get();
				return proxyValue(v, kind as ProxyKind, client);
			},
		};
		if (!readonly) {
			trap.set = (ctx, v) => {
				ctx.set(unproxyValue(v, client));
			};
		}

		client.RawTrap(target, member, trap as any);
	}

	// --- ES builtins not described by IDL -----------------------------------

	// You can't run defineProperty against the globalProxy without poisoning
	// the proxy's invariants -- redirect to the underlying global instead.
	// Use unproxyValue (null-safe) so we don't accidentally replace `null`
	// when documentProxy is disabled.
	client.Proxy("Object.defineProperty", {
		apply(ctx) {
			ctx.args[0] = unproxyValue(ctx.args[0], client);
		},
	});

	client.Proxy("Object.getOwnPropertyDescriptor", {
		apply(ctx) {
			ctx.args[0] = unproxyValue(ctx.args[0], client);

			const desc = ctx.call();
			if (!desc) return;

			// Native getters/setters returned in a descriptor take the underlying
			// platform object as their `this`; if the caller invokes them with
			// the proxy as receiver we have to swap it back.
			if (desc.get) {
				client.RawProxy(desc, "get", {
					apply(c) {
						c.this = unproxyValue(c.this, client);
					},
				});
			}
			if (desc.set) {
				client.RawProxy(desc, "set", {
					apply(c) {
						c.this = unproxyValue(c.this, client);
						for (let i = 0; i < c.args.length; i++) {
							c.args[i] = unproxyValue(c.args[i], client);
						}
					},
				});
			}

			ctx.return(desc);
		},
	});
}

/**
 * Legacy helper retained for backward compatibility with any consumer that
 * imported it. New code should rely on the IDL-driven hooks installed above.
 */
export function unproxy(ctx: ProxyCtx, client: ScramjetClient) {
	const self = client.global;
	if (ctx.this === client.globalProxy) ctx.this = self;
	if (ctx.this === client.documentProxy) ctx.this = self.document;

	for (const i in ctx.args) {
		if (ctx.args[i] === client.globalProxy) ctx.args[i] = self;
		if (ctx.args[i] === client.documentProxy) ctx.args[i] = self.document;
	}
}
