import { ScramjetClient } from "@client/client";
import { UNSAFE_GLOBALS } from "./wrap";
import { SCRAMJETCLIENT, SCRAMJETFRAME } from "@/symbols";

const inc = Array.prototype.includes;
const array_includes = (arr: any[], val: any) => inc.call(arr, val);

export default function (client: ScramjetClient, self: Self) {
	// Cache for wrapped getters/setters to ensure identity consistency
	// The descriptor objects themselves should be new each time (native behavior)
	// but the getter/setter functions inside should be the same
	const getterCache = new WeakMap<object, Map<string | symbol, Function>>();
	const setterCache = new WeakMap<object, Map<string | symbol, Function>>();

	const makeFakeDescriptor = (obj: any, prop: string | symbol) => {
		const desc = client.natives.call(
			"Reflect.getOwnPropertyDescriptor",
			null,
			obj,
			prop
		);
		if (!desc) return desc;

		if (desc.get) {
			// Check cache for getter
			let objGetterCache =
				obj && typeof obj === "object" ? getterCache.get(obj) : null;
			if (objGetterCache?.has(prop)) {
				desc.get = objGetterCache.get(prop);
			} else {
				// Create and cache new wrapped getter
				client.RawProxy(desc, "get", {
					apply(getctx) {
						getctx.return(client.wrapfn(getctx.call(), false));
					},
				});
				// Cache the wrapped getter
				if (obj && typeof obj === "object") {
					if (!objGetterCache) {
						objGetterCache = new Map();
						getterCache.set(obj, objGetterCache);
					}
					objGetterCache.set(prop, desc.get);
				}
			}
		}
		if (desc.set && prop === "location") {
			// Check cache for setter
			let objSetterCache =
				obj && typeof obj === "object" ? setterCache.get(obj) : null;
			if (objSetterCache?.has(prop)) {
				desc.set = objSetterCache.get(prop);
			} else {
				// Create and cache new wrapped setter
				client.RawProxy(desc, "set", {
					apply(setctx) {
						client.url = setctx.args[0];
						setctx.return(undefined);
					},
				});
				// Cache the wrapped setter
				if (obj && typeof obj === "object") {
					if (!objSetterCache) {
						objSetterCache = new Map();
						setterCache.set(obj, objSetterCache);
					}
					objSetterCache.set(prop, desc.set);
				}
			}
		}
		if ("value" in desc) {
			desc.value = client.wrapfn(desc.value, false);
		}

		return desc;
	};

	// Reflect.apply - should be safe
	// Reflect.construct - should be safe
	// We do need to worry about it overwriting our prototypes here though
	client.Proxy("Reflect.defineProperty", {
		apply(ctx) {
			const prop = ctx.args[1];
			if (typeof prop === "string") {
				for (const global of Object.values(client.config.globals)) {
					if (prop === global) {
						ctx.return(false);
					}
				}
			}
		},
	});

	// Reflect.deleteProperty functions like the delete operator so it's fine
	// Obviously just wrap the prop here
	client.Proxy(["Reflect.get", "Reflect.set"], {
		apply(ctx) {
			const prop = ctx.args[1];
			if (prop === SCRAMJETCLIENT || prop === SCRAMJETFRAME) {
				throw new TypeError("Cannot access internal scramjet properties");
			}

			if (typeof prop === "string" && array_includes(UNSAFE_GLOBALS, prop)) {
				ctx.args[1] = client.config.globals.wrappropertybase + prop;
			}
		},
	});

	client.Proxy(
		["Reflect.getOwnPropertyDescriptor", "Object.getOwnPropertyDescriptor"],
		{
			apply(ctx) {
				const prop = ctx.args[1];
				if (prop === SCRAMJETCLIENT || prop === SCRAMJETFRAME) {
					return ctx.return(undefined);
				}
				if (typeof prop === "string" && array_includes(UNSAFE_GLOBALS, prop)) {
					return ctx.return(makeFakeDescriptor(ctx.args[0], prop));
				}
			},
		}
	);

	// Reflect.getPrototypeOf - just __proto__ so it's fine
	// Reflect.has - need to hide scramjet props
	// Reflect.isExtensible - fine
	// Reflect.ownKeys - need to filter scramjet props
	// Reflect.setPrototypeOf - i think this is fine

	// Hide scramjet properties from Reflect.has / 'in' operator
	client.Proxy("Reflect.has", {
		apply(ctx) {
			const prop = ctx.args[1];
			if (typeof prop === "string") {
				if (prop.includes("scramjet") || prop.startsWith("$")) {
					// Check if it's actually on the object itself vs inherited from Object.prototype
					const obj = ctx.args[0];
					if (
						!Object.prototype.hasOwnProperty.call(obj, prop) &&
						Object.prototype.hasOwnProperty.call(Object.prototype, prop)
					) {
						// It's inherited from Object.prototype - hide it
						ctx.return(false);
					}
				}
			}
		},
	});

	client.Proxy("Object.getOwnPropertyDescriptors", {
		apply(ctx) {
			const descriptors = ctx.call();
			for (const prop of Reflect.ownKeys(descriptors)) {
				if (prop === SCRAMJETCLIENT || prop === SCRAMJETFRAME) {
					delete descriptors[prop];
					continue;
				}
				if (typeof prop === "string" && array_includes(UNSAFE_GLOBALS, prop)) {
					descriptors[prop] = makeFakeDescriptor(ctx.args[0], prop);
				}
			}
			ctx.return(descriptors);
		},
	});

	// Object.keys / Object.getOwnPropertyNames / Object.getOwnPropertySymbols leak keys but that's fine
	// This still needs to be wrapped, it's simple though
	client.Proxy("Object.values", {
		apply(ctx) {
			const values = ctx.call();
			ctx.return(values.map((v: any) => client.wrapfn(v, false)));
		},
	});

	client.Proxy("Object.entries", {
		apply(ctx) {
			const entries = ctx.call();
			ctx.return(entries.map((e: any) => [e[0], client.wrapfn(e[1], false)]));
		},
	});

	client.Proxy("Object.assign", {
		apply(ctx) {
			const [target, ...sources] = ctx.args;

			// Check if any source has unsafe globals that need wrapping
			let hasUnsafe = false;
			for (const source of sources) {
				if (source == null) continue;
				for (const g of UNSAFE_GLOBALS) {
					if (
						Object.prototype.hasOwnProperty.call(source, g) &&
						Object.prototype.propertyIsEnumerable.call(source, g)
					) {
						hasUnsafe = true;
						break;
					}
				}
				if (hasUnsafe) break;
			}

			// Special case: assigning location to window
			const assigningLocationToWindow =
				target === self &&
				sources.some(
					(s) =>
						s != null &&
						Object.prototype.hasOwnProperty.call(s, "location") &&
						Object.prototype.propertyIsEnumerable.call(s, "location")
				);

			if (!hasUnsafe && !assigningLocationToWindow) {
				// Fast path: no unsafe globals, use native Object.assign
				return;
			}

			// Slow path: need to intercept unsafe globals
			// First, do native assign to get proper behavior (throwing on frozen, etc.)
			const result = ctx.call();

			// Then wrap any unsafe globals that were assigned
			for (const g of UNSAFE_GLOBALS) {
				if (
					Object.prototype.hasOwnProperty.call(target, g) &&
					Object.prototype.propertyIsEnumerable.call(target, g)
				) {
					target[g] = client.wrapfn(target[g], false);
				}
			}

			// Handle location assignment to window
			if (assigningLocationToWindow) {
				for (const source of sources) {
					if (
						source != null &&
						Object.prototype.hasOwnProperty.call(source, "location") &&
						Object.prototype.propertyIsEnumerable.call(source, "location")
					) {
						client.url = source.location;
					}
				}
			}

			ctx.return(result);
		},
	});

	// __lookupGetter__ and __lookupSetter__ are deprecated but still work
	// They can be used to get the native getters and bypass our interception
	client.Proxy("Object.prototype.__lookupGetter__", {
		apply(ctx) {
			const prop = ctx.args[0];
			if (
				ctx.this != null &&
				typeof prop === "string" &&
				array_includes(UNSAFE_GLOBALS, prop)
			) {
				const desc = makeFakeDescriptor(ctx.this, prop);
				ctx.return(desc?.get);
			}
			// Otherwise fall through to native
		},
	});

	client.Proxy("Object.prototype.__lookupSetter__", {
		apply(ctx) {
			const prop = ctx.args[0];
			if (
				ctx.this != null &&
				typeof prop === "string" &&
				array_includes(UNSAFE_GLOBALS, prop)
			) {
				const desc = makeFakeDescriptor(ctx.this, prop);
				ctx.return(desc?.set);
			}
			// Otherwise fall through to native
		},
	});

	// Hide scramjet properties from Object.getOwnPropertyNames on Object.prototype
	client.Proxy("Object.getOwnPropertyNames", {
		apply(ctx) {
			const names = ctx.call();
			if (ctx.args[0] === Object.prototype) {
				ctx.return(
					names.filter(
						(name: string) =>
							!name.includes("scramjet") && !name.startsWith("$")
					)
				);
			}
		},
	});

	// Hide scramjet properties from Reflect.ownKeys on Object.prototype
	client.Proxy("Reflect.ownKeys", {
		apply(ctx) {
			const keys = ctx.call();
			if (ctx.args[0] === Object.prototype) {
				ctx.return(
					keys.filter((key: string | symbol) => {
						if (typeof key === "string") {
							return !key.includes("scramjet") && !key.startsWith("$");
						}
						return true;
					})
				);
			}
		},
	});
}
