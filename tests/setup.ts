/**
 * Node 22+ ships an experimental `globalThis.localStorage` getter that yields `undefined` unless Node is started with
 * `--localstorage-file`. Under vitest's jsdom environment `window` is that same global, so jsdom's real Storage never
 * gets installed and the bridge (which persists its token in localStorage) cannot run. Install a minimal in-memory
 * Storage when the global one is unusable. Node < 22 and browsers are unaffected.
 */
class MemoryStorage implements Storage {
	private readonly map = new Map<string, string>();
	get length(): number {
		return this.map.size;
	}
	clear(): void {
		this.map.clear();
	}
	getItem(key: string): string | null {
		return this.map.has(key) ? (this.map.get(key) as string) : null;
	}
	key(index: number): string | null {
		return [...this.map.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.map.delete(key);
	}
	setItem(key: string, value: string): void {
		this.map.set(key, String(value));
	}
}

if (typeof window !== "undefined") {
	let current: unknown;
	try {
		current = globalThis.localStorage;
	} catch {
		current = undefined;
	}
	if (!current || typeof (current as Storage).setItem !== "function") {
		Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true });
	}
}
