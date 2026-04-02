export interface FileTrackingState {
	lastReadMtimeMs?: number;
	lastAgentEditMtimeMs?: number;
}

/** In-memory state store keyed by canonical absolute file path. */
export class FileTrackingStore {
	private readonly byCanonicalPath = new Map<string, FileTrackingState>();

	get(path: string): FileTrackingState | undefined {
		const state = this.byCanonicalPath.get(path);
		if (!state) return undefined;
		return { ...state };
	}

	entries(): Array<{ path: string; state: FileTrackingState }> {
		return Array.from(this.byCanonicalPath.entries()).map(([path, state]) => ({
			path,
			state: { ...state },
		}));
	}

	markRead(path: string, mtimeMs: number): void {
		const current = this.byCanonicalPath.get(path) ?? {};
		this.byCanonicalPath.set(path, {
			...current,
			lastReadMtimeMs: mtimeMs,
		});
	}

	markAgentEdit(path: string, mtimeMs: number): void {
		const current = this.byCanonicalPath.get(path) ?? {};
		this.byCanonicalPath.set(path, {
			...current,
			lastAgentEditMtimeMs: mtimeMs,
			lastReadMtimeMs: mtimeMs,
		});
	}

	clear(): void {
		this.byCanonicalPath.clear();
	}

	size(): number {
		return this.byCanonicalPath.size;
	}
}
