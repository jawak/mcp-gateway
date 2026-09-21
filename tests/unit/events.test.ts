import { describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../src/lib/server/registry/events';
import { clientIp } from '../../src/lib/server/http/forwarded';

describe('EventBus', () => {
	test('delivers typed payloads to subscribers', async () => {
		const bus = new EventBus();
		const seen: string[] = [];
		bus.on('upstream.changed', ({ slug }) => {
			seen.push(slug);
		});
		bus.emit('upstream.changed', { slug: 'github', enabled: true });
		await Promise.resolve();
		expect(seen).toEqual(['github']);
	});

	test('unsubscribe stops delivery', async () => {
		const bus = new EventBus();
		let calls = 0;
		const off = bus.on('key.revoked', () => {
			calls += 1;
		});
		bus.emit('key.revoked', { keyId: 'k1' });
		await Promise.resolve();
		off();
		bus.emit('key.revoked', { keyId: 'k2' });
		await Promise.resolve();
		expect(calls).toBe(1);
	});

	test('a throwing handler does not break the emitter or siblings', async () => {
		const bus = new EventBus();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		let survivor = 0;
		bus.on('profile.changed', () => {
			throw new Error('boom');
		});
		bus.on('profile.changed', () => {
			survivor += 1;
		});
		expect(() => bus.emit('profile.changed', { profileId: 'p1' })).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(survivor).toBe(1);
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	test('removeAllHandlers clears every subscription', async () => {
		const bus = new EventBus();
		let calls = 0;
		bus.on('session.closed', () => {
			calls += 1;
		});
		bus.removeAllHandlers();
		bus.emit('session.closed', { sessionId: 's1', reason: 'gc' });
		await Promise.resolve();
		expect(calls).toBe(0);
	});
});

describe('clientIp', () => {
	test('uses the left-most forwarded hop when the proxy is trusted', () => {
		expect(clientIp(new Headers(), '203.0.113.7, 10.0.0.1', true)).toBe('203.0.113.7');
	});

	test('ignores X-Forwarded-For when the proxy is not trusted', () => {
		const headers = new Headers({ 'x-real-ip': '198.51.100.9' });
		expect(clientIp(headers, '203.0.113.7', false)).toBe('198.51.100.9');
	});

	test('falls back to unknown without any header', () => {
		expect(clientIp(new Headers(), undefined, true)).toBe('unknown');
	});
});
