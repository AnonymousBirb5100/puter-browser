import { ProxyCtx, ScramjetClient } from "@client/client";
import { SCRAMJETCLIENT } from "@/symbols";
import {
	OPERATIONS,
	ATTRIBUTES,
	type ArgSelector,
	type ProxyKind,
} from "../unproxy.generated";

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

	// Direct hit on this realm.
	if (v === client.global) return client.globalProxy;
	if (v === client.global.document) return client.documentProxy;

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

export default function (client: ScramjetClient, self: typeof window) {
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

		if (isCtor) {
			client.RawProxy(
				self,
				owner,
				{
					construct(ctx) {
						unproxyArgs(ctx.args as any[], argSelectors, client);
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

		const wrapsArgs = argSelectors.length > 0;
		const wrapsReturn = !!returnKind;

		client.RawProxy(
			target,
			member,
			{
				apply(ctx) {
					// Always normalize `this` so passing the global/document proxy
					// in as the receiver doesn't trip "Illegal invocation".
					if (ctx.this === client.globalProxy) ctx.this = self as any;
					else if (ctx.this === client.documentProxy)
						ctx.this = self.document as any;

					if (wrapsArgs) unproxyArgs(ctx.args as any[], argSelectors, client);

					if (wrapsReturn) {
						const result = ctx.call();
						ctx.return(proxyValue(result, returnKind as ProxyKind, client));
					}
				},
			},
			`${owner}${isStatic || GLOBAL_OWNERS.has(owner) ? "" : ".prototype"}.${member}`
		);
	}

	// --- IDL-driven attribute traps -----------------------------------------
	for (const [owner, member, isStatic, kind, readonly] of ATTRIBUTES) {
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
	client.Proxy("Object.defineProperty", {
		apply(ctx) {
			if (ctx.args[0] === client.globalProxy) ctx.args[0] = self;
			else if (ctx.args[0] === client.documentProxy)
				ctx.args[0] = self.document;
		},
	});

	client.Proxy("Object.getOwnPropertyDescriptor", {
		apply(ctx) {
			if (ctx.args[0] === client.globalProxy) ctx.args[0] = self;
			else if (ctx.args[0] === client.documentProxy)
				ctx.args[0] = self.document;

			const desc = ctx.call();
			if (!desc) return;

			// Native getters/setters returned in a descriptor take the underlying
			// platform object as their `this`; if the caller invokes them with
			// the proxy as receiver we have to swap it back.
			if (desc.get) {
				client.RawProxy(desc, "get", {
					apply(c) {
						if (c.this === client.globalProxy) c.this = self;
						else if (c.this === client.documentProxy) c.this = self.document;
					},
				});
			}
			if (desc.set) {
				client.RawProxy(desc, "set", {
					apply(c) {
						if (c.this === client.globalProxy) c.this = self;
						else if (c.this === client.documentProxy) c.this = self.document;
						for (let i = 0; i < c.args.length; i++) {
							if (c.args[i] === client.globalProxy) c.args[i] = self;
							else if (c.args[i] === client.documentProxy)
								c.args[i] = self.document;
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
