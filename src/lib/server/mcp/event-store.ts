/**
 * Resumability store (T-12).
 *
 * MCP Streamable HTTP allows a client to reconnect with `Last-Event-ID` and ask
 * for whatever it missed. The gateway keeps a bounded in-memory ring per stream
 * so a flaky laptop connection does not lose tool results.
 *
 * Bounded on purpose: an unbounded cache keyed by an attacker-controlled stream
 * would be a memory leak. When a client resumes with an id that has already been
 * evicted the SDK simply sends nothing, which is the correct "too old" behaviour.
 */
import type {
	EventId,
	EventStore,
	StreamId
} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type StoredEvent = { eventId: EventId; message: JSONRPCMessage };

const DEFAULT_CAPACITY_PER_STREAM = 1_000;
const DEFAULT_MAX_STREAMS = 500;

export class MemoryEventStore implements EventStore {
	#byStream = new Map<StreamId, { events: StoredEvent[] }>();
	#streamByEvent = new Map<EventId, StreamId>();
	/**
	 * Store-wide monotonic counter: event ids must stay unique even after a
	 * stream is released, otherwise a stale `Last-Event-ID` could resolve into a
	 * different session's event history.
	 */
	#sequence = 0;
	#capacity: number;
	#maxStreams: number;

	constructor(options: { capacityPerStream?: number; maxStreams?: number } = {}) {
		this.#capacity = Math.max(1, options.capacityPerStream ?? DEFAULT_CAPACITY_PER_STREAM);
		this.#maxStreams = Math.max(1, options.maxStreams ?? DEFAULT_MAX_STREAMS);
	}

	async storeEvent(stream: StreamId, message: JSONRPCMessage): Promise<EventId> {
		let bucket = this.#byStream.get(stream);
		if (!bucket) {
			bucket = { events: [] };
			this.#byStream.set(stream, bucket);
			this.#evictOldestStreamIfNeeded();
		}
		const eventId = `${stream}:${++this.#sequence}`;
		bucket.events.push({ eventId, message });
		this.#streamByEvent.set(eventId, stream);
		while (bucket.events.length > this.#capacity) {
			const dropped = bucket.events.shift();
			if (dropped) this.#streamByEvent.delete(dropped.eventId);
		}
		return eventId;
	}

	async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
		return this.#streamByEvent.get(eventId);
	}

	async replayEventsAfter(
		lastEventId: EventId,
		{ send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
	): Promise<StreamId> {
		const stream = this.#streamByEvent.get(lastEventId);
		if (!stream) {
			// unknown or already evicted id: nothing to replay
			return '';
		}
		const bucket = this.#byStream.get(stream);
		if (!bucket) return stream;
		const index = bucket.events.findIndex((event) => event.eventId === lastEventId);
		if (index === -1) return stream;
		for (const event of bucket.events.slice(index + 1)) {
			await send(event.eventId, event.message);
		}
		return stream;
	}

	/** Free everything belonging to a session (called when the session closes). */
	releaseStream(stream: StreamId): void {
		const bucket = this.#byStream.get(stream);
		if (!bucket) return;
		for (const event of bucket.events) this.#streamByEvent.delete(event.eventId);
		this.#byStream.delete(stream);
	}

	get size(): { streams: number; events: number } {
		let events = 0;
		for (const bucket of this.#byStream.values()) events += bucket.events.length;
		return { streams: this.#byStream.size, events };
	}

	#evictOldestStreamIfNeeded(): void {
		if (this.#byStream.size < this.#maxStreams) return;
		const oldest = this.#byStream.keys().next().value as StreamId | undefined;
		if (oldest) this.releaseStream(oldest);
	}
}
