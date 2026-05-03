type KVType = "localstorage" | "puter";

/**
 * Smart JSON serializer that handles circular references.
 * Uses a WeakMap to track visited objects and replaces circular references
 * with unique reference IDs that can be reconstructed during parsing.
 */
function smartSerialize(value: any): string {
	const visited = new WeakMap<object, number>();
	let refCounter = 0;

	function replacer(key: string, val: any): any {
		if (val === null || typeof val !== "object") {
			return val;
		}

		// Check for circular reference
		if (visited.has(val)) {
			const refId = visited.get(val)!;
			return { __circular_ref__: refId };
		}

		// Track this object with a unique ID
		const refId = refCounter++;
		visited.set(val, refId);

		return val;
	}

	try {
		const serialized = JSON.stringify(value, replacer);
		return serialized;
	} catch (error) {
		// Fallback to regular JSON.stringify if something goes wrong
		return JSON.stringify(value);
	}
}

/**
 * Smart JSON parser that reconstructs circular references.
 * Replaces circular reference placeholders with actual object references.
 */
function smartParse<T = any>(json: string): T {
	const parsed = JSON.parse(json);

	// First pass: collect all objects in DFS order to build reference map
	const objects: any[] = [];
	const visited = new WeakSet<object>();

	function collectObjects(obj: any): void {
		if (obj === null || typeof obj !== "object" || visited.has(obj)) {
			return;
		}

		// Skip circular reference placeholders
		if (obj.__circular_ref__ !== undefined && Object.keys(obj).length === 1) {
			return;
		}

		visited.add(obj);
		objects.push(obj);

		if (Array.isArray(obj)) {
			obj.forEach((item) => collectObjects(item));
		} else {
			for (const key in obj) {
				if (obj.hasOwnProperty(key)) {
					collectObjects(obj[key]);
				}
			}
		}
	}

	collectObjects(parsed);

	// Second pass: resolve circular references
	function resolveRefs(
		obj: any,
		resolving: WeakSet<object> = new WeakSet()
	): any {
		if (obj === null || typeof obj !== "object") {
			return obj;
		}

		// Handle circular reference placeholder
		if (obj.__circular_ref__ !== undefined && Object.keys(obj).length === 1) {
			const refId = obj.__circular_ref__;
			return objects[refId] || obj;
		}

		// Avoid infinite loops during resolution
		if (resolving.has(obj)) {
			return obj;
		}
		resolving.add(obj);

		if (Array.isArray(obj)) {
			for (let i = 0; i < obj.length; i++) {
				obj[i] = resolveRefs(obj[i], resolving);
			}
		} else {
			for (const key in obj) {
				if (obj.hasOwnProperty(key)) {
					obj[key] = resolveRefs(obj[key], resolving);
				}
			}
		}

		resolving.delete(obj);
		return obj;
	}

	return resolveRefs(parsed) as T;
}

export class KVWrapper {
	prefix = "bjs-";
	constructor(private type: KVType) {}

	async rawget(key: string): Promise<string | null> {
		if (this.type === "localstorage") {
			return localStorage.getItem(this.prefix + key);
		} else {
			return await puter.kv.get(key);
		}
	}

	async rawset(key: string, value: string): Promise<void> {
		if (this.type === "localstorage") {
			localStorage.setItem(this.prefix + key, value);
		} else {
			await puter.kv.set(key, value);
		}
	}

	async remove(key: string): Promise<void> {
		if (this.type === "localstorage") {
			localStorage.removeItem(this.prefix + key);
		} else {
			await puter.kv.del(key);
		}
	}

	async has(key: string): Promise<boolean> {
		if (this.type === "localstorage") {
			return localStorage.getItem(this.prefix + key) !== null;
		} else {
			return (await puter.kv.list(key)).length;
		}
	}

	async get<T = any>(key: string): Promise<T | null> {
		const value = await this.rawget(key);
		if (value === null) {
			return null;
		}
		try {
			return smartParse<T>(value);
		} catch (error) {
			console.error(`Failed to parse JSON for key "${key}":`, error);
			return null;
		}
	}

	async set(key: string, value: any): Promise<void> {
		const serialized = smartSerialize(value);
		await this.rawset(key, serialized);
	}
}
