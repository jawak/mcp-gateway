import { describe, expect, test } from 'bun:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MemoryEventStore } from '../../src/lib/server/mcp/event-store';

const message = (id: number): JSONRPCMessage =>
	({ jsonrpc: '2.0', id, result: { ok: true } }) as JSONRPCMessage;

describe('MemoryEventStore', () => {
	test('stores events and replays everything after the given id', async () => {
		const store = new MemoryEventStore();
		const ids: string[] = [];
		for (let index = 1; index <= 5; index += 1)
			ids.push(await store.storeEvent('stream-1', message(index)));

		const replayed: Array<{ id: string; payload: unknown }> = [];
		const stream = await store.replayEventsAfter(ids[1] as string, {
			send: async (eventId, payload) => {
				replayed.push({ id: eventId, payload });
			}
		});

		expect(stream).toBe('stream-1');
		expect(replayed.map((entry) => entry.id)).toEqual([ids[2], ids[3], ids[4]].filter(Boolean));
	});

	test('replaying from the newest id yields nothing', async () => {
		const store = new MemoryEventStore();
		const last = await store.storeEvent('s', message(1));
		const sent: string[] = [];
		await store.replayEventsAfter(last, {
			send: async (eventId) => {
				sent.push(eventId);
			}
		});
		expect(sent).toEqual([]);
	});

	test('an unknown or evicted id replays nothing but does not throw', async () => {
		const store = new MemoryEventStore();
		await store.storeEvent('s', message(1));
		const sent: string[] = [];
		const stream = await store.replayEventsAfter('s:9999', {
			send: async (eventId) => {
				sent.push(eventId);
			}
		});
		expect(stream).toBe('');
		expect(sent).toEqual([]);
	});

	test('per-stream capacity drops the oldest events and keeps the newest', async () => {
		const store = new MemoryEventStore({ capacityPerStream: 3 });
		const ids: string[] = [];
		for (let index = 1; index <= 6; index += 1)
			ids.push(await store.storeEvent('cap', message(index)));

		expect(store.size).toEqual({ streams: 1, events: 3 });
		// the oldest id has been evicted
		expect(await store.getStreamIdForEventId(ids[0] as string)).toBeUndefined();
		expect(await store.getStreamIdForEventId(ids[5] as string)).toBe('cap');

		const sent: string[] = [];
		await store.replayEventsAfter(ids[4] as string, {
			send: async (eventId) => {
				sent.push(eventId);
			}
		});
		expect(sent).toEqual([ids[5]]);
	});

	test('streams are isolated from each other', async () => {
		const store = new MemoryEventStore();
		const a = await store.storeEvent('a', message(1));
		await store.storeEvent('b', message(2));
		const sent: string[] = [];
		await store.replayEventsAfter(a, {
			send: async (eventId) => {
				sent.push(eventId);
			}
		});
		expect(sent).toEqual([]);
		expect(store.size.streams).toBe(2);
	});

	test('releaseStream frees the events and the index', async () => {
		const store = new MemoryEventStore();
		const id = await store.storeEvent('temp', message(1));
		await store.storeEvent('keep', message(2));
		store.releaseStream('temp');
		expect(store.size).toEqual({ streams: 1, events: 1 });
		expect(await store.getStreamIdForEventId(id)).toBeUndefined();
	});

	test('the number of live streams is bounded', async () => {
		const store = new MemoryEventStore({ capacityPerStream: 2, maxStreams: 3 });
		for (let stream = 0; stream < 10; stream += 1) {
			await store.storeEvent(`stream-${stream}`, message(stream));
		}
		expect(store.size.streams).toBeLessThanOrEqual(3);
	});

	test('ids are unique even when a stream restarts', async () => {
		const store = new MemoryEventStore();
		const first = await store.storeEvent('same', message(1));
		store.releaseStream('same');
		const second = await store.storeEvent('same', message(2));
		expect(first).not.toBe(second);
	});
});
