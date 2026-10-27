/**
 * Auth-mode contract (todo 2).
 *
 * `resolveAuthMode` is the single source of truth for how an HTTP upstream is
 * authenticated. Absence of `authMode` must keep resolving exactly as today, so
 * every pre-existing record stays byte-for-byte compatible.
 *
 * The registry half enforces the matrix at the only write path: a rejected
 * `oauth`/`static` combination must fail before the insert/update so no row (or
 * partial update) is left behind.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
	createUpstream,
	ensureLoaded,
	getUpstreamById,
	listUpstreams,
	RegistryError,
	updateUpstream
} from '../../src/lib/server/registry';
import {
	resolveAuthMode,
	type AuthMode,
	type HttpConnection
} from '../../src/lib/server/upstream/types';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { resetConfigCache } from '../../src/lib/server/config';

let dir: string;
let sequence = 0;

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-auth-mode-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '5'.repeat(64);
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	ensureLoaded(getDb());
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	resetConfigCache();
});

function nextSlug(): string {
	sequence += 1;
	return `auth-mode-${sequence}`;
}

function connection(overrides: Partial<HttpConnection> = {}): HttpConnection {
	return { url: 'https://example.test/mcp', ...overrides };
}

function rowsForSlug(slug: string) {
	return listUpstreams(getDb()).filter((record) => record.slug === slug);
}

function create(slug: string, transport: 'stdio' | 'http', conn: unknown, headersRef?: string) {
	return createUpstream({
		slug,
		name: slug,
		transport,
		connection: conn as never,
		headersRef
	});
}

function expectInvalidAuthMode(run: () => unknown, slug: string): void {
	let error: unknown;
	try {
		run();
	} catch (cause) {
		error = cause;
	}
	expect(error).toBeInstanceOf(RegistryError);
	expect((error as RegistryError).code).toBe('invalid_auth_mode');
	expect((error as Error).message.length).toBeGreaterThan(20);
	expect(rowsForSlug(slug)).toHaveLength(0);
}

describe('resolveAuthMode', () => {
	test('every explicit mode wins over inferred refs', () => {
		const cases: Array<[HttpConnection, string | null, AuthMode]> = [
			[connection({ authMode: 'oauth' }), null, 'oauth'],
			[connection({ authMode: 'static', authRef: 'secret:x' }), null, 'static'],
			[connection({ authMode: 'none', authRef: 'secret:x' }), 'secret:y', 'none']
		];
		for (const [conn, headersRef, expected] of cases) {
			expect(resolveAuthMode(conn, headersRef)).toBe(expected);
		}
	});

	test('a legacy record without authMode infers static from either ref, else none', () => {
		expect(resolveAuthMode(connection({ authRef: 'secret:x' }), null)).toBe('static');
		expect(resolveAuthMode(connection(), 'secret:headers')).toBe('static');
		expect(resolveAuthMode(connection({ authStyle: 'bearer' }), null)).toBe('none');
		expect(resolveAuthMode({ command: 'echo', args: [] }, null)).toBe('none');
	});

	test('a JSON connection blob and a nullable headersRef are accepted', () => {
		const blob = JSON.parse(
			JSON.stringify({ url: 'https://example.test/mcp', authMode: 'oauth' })
		) as HttpConnection;
		expect(resolveAuthMode(blob, null)).toBe('oauth');
		expect(resolveAuthMode(blob, undefined)).toBe('oauth');
	});
});

describe('createUpstream auth-mode matrix', () => {
	test('oauth over HTTP persists authMode inside connection JSON and no authRef', () => {
		const slug = nextSlug();
		create(slug, 'http', connection({ authMode: 'oauth', authStyle: 'none' }));
		const record = getUpstreamById(rowsForSlug(slug)[0].id);
		const conn = record?.connection as HttpConnection;
		expect(conn.authMode).toBe('oauth');
		expect(conn.authRef).toBeUndefined();
		expect(record?.headersRef ?? null).toBeNull();
	});

	test('explicit 3×3 matrix: oauth/static/none against http/stdio/legacy', () => {
		type Row = {
			mode: AuthMode;
			shape: 'http' | 'stdio' | 'legacy';
			ok: boolean;
		};
		const expected: Row[] = [];
		for (const mode of ['oauth', 'static', 'none'] as const) {
			expected.push({ mode, shape: 'http', ok: true });
			expected.push({ mode, shape: 'stdio', ok: mode === 'none' });
			expected.push({ mode, shape: 'legacy', ok: true });
		}

		for (const row of expected) {
			const slug = nextSlug();
			const ref = row.mode === 'static' ? 'secret:ref' : undefined;
			const transport = row.shape === 'stdio' ? 'stdio' : 'http';
			const conn =
				row.shape === 'stdio'
					? { command: 'echo', args: [], authMode: row.mode }
					: connection({
							...(row.shape === 'legacy' ? {} : { authMode: row.mode }),
							...(ref ? { authRef: ref } : {})
						});
			if (row.ok) {
				create(slug, transport, conn);
				expect(rowsForSlug(slug)).toHaveLength(1);
			} else {
				expectInvalidAuthMode(() => create(slug, transport, conn), slug);
			}
		}
	});

	test('oauth rejects authRef, headersRef and authStyle', () => {
		for (const bad of [
			connection({ authMode: 'oauth', authRef: 'secret:x' }),
			connection({ authMode: 'oauth', authStyle: 'bearer' })
		]) {
			const slug = nextSlug();
			expectInvalidAuthMode(() => create(slug, 'http', bad), slug);
		}

		const slug = nextSlug();
		expectInvalidAuthMode(
			() => create(slug, 'http', connection({ authMode: 'oauth' }), 'secret:headers'),
			slug
		);
	});

	test('oauth on stdio is rejected and writes nothing', () => {
		const slug = nextSlug();
		expectInvalidAuthMode(
			() => create(slug, 'stdio', { command: 'echo', args: [], authMode: 'oauth' }),
			slug
		);
	});

	test('static requires authRef or headersRef', () => {
		const slug = nextSlug();
		expectInvalidAuthMode(
			() => create(slug, 'http', connection({ authMode: 'static', authStyle: 'bearer' })),
			slug
		);

		const withHeaderRef = nextSlug();
		create(withHeaderRef, 'http', connection({ authMode: 'static' }), 'secret:headers');
		expect(rowsForSlug(withHeaderRef)).toHaveLength(1);
	});

	test('none ignores refs and leaves them untouched', () => {
		const slug = nextSlug();
		create(slug, 'http', connection({ authMode: 'none', authRef: 'secret:x' }), 'secret:h');
		const record = getUpstreamById(rowsForSlug(slug)[0].id);
		expect((record?.connection as HttpConnection).authMode).toBe('none');
		expect((record?.connection as HttpConnection).authRef).toBe('secret:x');
		expect(record?.headersRef).toBe('secret:h');
	});

	test('a legacy record without authMode keeps working and resolves to none', () => {
		const slug = nextSlug();
		create(slug, 'http', connection());
		const record = getUpstreamById(rowsForSlug(slug)[0].id);
		expect(resolveAuthMode(record?.connection as HttpConnection, record?.headersRef)).toBe('none');
	});

	test('a legacy record with authRef resolves to static and is unchanged', () => {
		const slug = nextSlug();
		create(slug, 'http', connection({ authRef: 'secret:x' }));
		const record = getUpstreamById(rowsForSlug(slug)[0].id);
		expect(resolveAuthMode(record?.connection as HttpConnection, record?.headersRef)).toBe(
			'static'
		);
	});
});

describe('updateUpstream auth-mode matrix', () => {
	test('switching an oauth upstream to stdio is rejected without a write', () => {
		const slug = nextSlug();
		create(slug, 'http', connection({ authMode: 'oauth' }));
		const record = rowsForSlug(slug)[0];

		let error: unknown;
		try {
			updateUpstream(record.id, { transport: 'stdio' });
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).code).toBe('invalid_auth_mode');
		expect(getUpstreamById(record.id)?.transport).toBe('http');
	});

	test('switching to oauth while headersRef remains set is rejected; clearing it succeeds', () => {
		const slug = nextSlug();
		create(slug, 'http', connection({ authRef: 'secret:x' }), 'secret:headers');
		const record = rowsForSlug(slug)[0];

		let error: unknown;
		try {
			updateUpstream(record.id, { connection: connection({ authMode: 'oauth' }) });
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).code).toBe('invalid_auth_mode');
		expect(getUpstreamById(record.id)?.headersRef).toBe('secret:headers');

		updateUpstream(record.id, {
			connection: connection({ authMode: 'oauth' }),
			headersRef: null
		});
		const updated = getUpstreamById(record.id);
		expect((updated?.connection as HttpConnection).authMode).toBe('oauth');
		expect(updated?.headersRef ?? null).toBeNull();
	});

	test('switching to static without a ref is rejected and leaves the old rows intact', () => {
		const slug = nextSlug();
		create(slug, 'http', connection({ authMode: 'oauth' }));
		const record = rowsForSlug(slug)[0];

		let error: unknown;
		try {
			updateUpstream(record.id, { connection: connection({ authMode: 'static' }) });
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).code).toBe('invalid_auth_mode');
		expect((getUpstreamById(record.id)?.connection as HttpConnection).authMode).toBe('oauth');
	});

	test('adding authRef to an oauth connection is rejected without a write', () => {
		const slug = nextSlug();
		create(slug, 'http', connection({ authMode: 'oauth' }));
		const record = rowsForSlug(slug)[0];

		let error: unknown;
		try {
			updateUpstream(record.id, {
				connection: connection({ authMode: 'oauth', authRef: 'secret:x' })
			});
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).code).toBe('invalid_auth_mode');
		expect((getUpstreamById(record.id)?.connection as HttpConnection).authRef).toBeUndefined();
	});
});
