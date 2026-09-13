/**
 * A minimal push-based `ReadableStream` wrapper. Backends produce events
 * with `push` and end the run with `close`.
 */
export interface PushStream<T> {
	stream: ReadableStream<T>;
	/** Queue one event. No-op after `close`. */
	push(value: T): void;
	/** End the stream. No-op when already closed. */
	close(): void;
}

export function createPushStream<T>(): PushStream<T> {
	let controller: ReadableStreamDefaultController<T> | undefined;
	let closed = false;
	const stream = new ReadableStream<T>({
		start(c) {
			controller = c;
		},
		cancel() {
			closed = true;
		},
	});
	return {
		stream,
		push(value) {
			if (!closed && controller) {
				controller.enqueue(value);
			}
		},
		close() {
			if (!closed && controller) {
				closed = true;
				controller.close();
			}
		},
	};
}
