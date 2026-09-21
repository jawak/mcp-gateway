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

describe('session liveness writes (T-13, T-44)', () => {
	test('last_seen_at is written once, not once per request', async () => {
		const { SessionRegistry } = await import('../../src/lib/server/mcp/session');
		let seenWrites = 0;
		const sessions = new SessionRegistry({
			store: { created: () => {}, seen: () => (seenWrites += 1), closed: () => {} }
		});
		const session = sessions.register({
			id: 'sess-1',
			caller: { apiKeyId: 'k', keyName: 'k', profileId: 'p', requestId: 'r', clientAddress: '::1' },
			protocolVersion: '2025-06-18',
			clientInfo: null,
			unwatch: () => {}
		} as never);
		expect(session).toBeDefined();
		const baseline = seenWrites;
		for (let index = 0; index < 500; index += 1) sessions.get('sess-1');
		// the first lookup has no recorded write yet and legitimately stamps one;
		// the remaining 499 must be free
		expect(seenWrites - baseline).toBeLessThanOrEqual(1);

		sessions.close('sess-1', 'client');
	});

	test('closing flushes the true last-activity time', async () => {
		const { SessionRegistry } = await import('../../src/lib/server/mcp/session');
		const stamps: string[] = [];
		const sessions = new SessionRegistry({
			store: { created: () => {}, seen: (id, at) => stamps.push(at), closed: () => {} }
		});
		sessions.register({
			id: 'sess-2',
			caller: { apiKeyId: 'k', keyName: 'k', profileId: 'p', requestId: 'r', clientAddress: '::1' },
			protocolVersion: '2025-06-18',
			clientInfo: null,
			unwatch: () => {}
		} as never);
		const afterOpen = stamps.length;
		for (let index = 0; index < 100; index += 1) sessions.get('sess-2');
		expect(stamps.length - afterOpen).toBeLessThanOrEqual(1);
		const beforeClose = stamps.length;
		await sessions.close('sess-2', 'client');
		// close always persists the final activity time
		expect(stamps.length).toBeGreaterThan(beforeClose);
	});
});
