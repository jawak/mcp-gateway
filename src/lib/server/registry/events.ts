/**
 * Typed in-process event bus.
 *
 * Modules communicate through these events instead of importing each other
 * (registry → catalog invalidation, key revoke → session close, health →
 * catalog). Kept tiny and synchronous: handlers must not block, long work is
 * expected to be scheduled by the subscriber.
 */

export type GatewayEvents = {
	'upstream.changed': { slug: string; enabled: boolean };
	'upstream.enabled': { slug: string; enabled: boolean };
	'profile.changed': { profileId: string };
	'health.changed': { slug: string; status: string; previous: string };
	'key.revoked': { keyId: string };
	'key.suspended': { keyId: string };
	'session.closed': { sessionId: string; reason: string };
	'pool.connected': { slug: string; transport: 'stdio' | 'http' };
	'pool.closed': {
		slug: string;
		reason: 'idle' | 'manual' | 'evicted' | 'shutdown' | 'unconfigured';
	};
	shutdown: { reason: 'SIGINT' | 'SIGTERM' };
};

type EventName = keyof GatewayEvents;
type Handler<K extends EventName> = (payload: GatewayEvents[K]) => void | Promise<void>;
type AnyHandler = (payload: never) => void | Promise<void>;

export class EventBus {
	#listeners = new Map<EventName, Set<AnyHandler>>();

	on<K extends EventName>(name: K, handler: Handler<K>): () => void {
		const set = this.#listeners.get(name) ?? new Set<AnyHandler>();
		this.#listeners.set(name, set);
		set.add(handler as AnyHandler);
		return () => this.off(name, handler);
	}

	off<K extends EventName>(name: K, handler: Handler<K>): void {
		this.#listeners.get(name)?.delete(handler as AnyHandler);
	}

	emit<K extends EventName>(name: K, payload: GatewayEvents[K]): void {
		const set = this.#listeners.get(name);
		if (!set) return;
		for (const handler of [...set]) {
			// fire-and-forget: subscriber errors must never break the emitter
			Promise.resolve()
				.then(() => (handler as Handler<K>)(payload))
				.catch((error: unknown) => {
					console.error({ error, event: name }, 'event handler failed');
				});
		}
	}

	removeAllHandlers(): void {
		this.#listeners.clear();
	}
}

/** Process-wide bus. Import this instead of creating instances. */
export const events = new EventBus();
