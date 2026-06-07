export class SkiBidiMap<K, V> {
	forward = new Map<K, V>();
	reverse = new Map<V, K>();

	set(key: K, value: V) {
		this.forward.set(key, value);
		this.reverse.set(value, key);
	}

	get(key: K): V | undefined {
		return this.forward.get(key);
	}

	getKey(value: V): K | undefined {
		return this.reverse.get(value);
	}
}
