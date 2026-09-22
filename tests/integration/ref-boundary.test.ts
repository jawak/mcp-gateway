/**
 * The reference boundary (BR-09, enforced at the registry).
 *
 * Two invariants, both cheap to break by accident:
 *   1. no caller can store a credential in an upstream — not the form, not a template,
 *      not a manifest, not a script;
 *   2. `renderManifest()` refuses to write a file that would carry one.
 *
 * The false-positive half matters as much as the rejecting half: the detector fires on
 * the colon in `secret:pg-dev__url`, so if the boundary ever checks references as well as
 * literals it would reject every legitimate secret reference in the database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
	createUpstream,
	ensureLoaded,
	RegistryError,
	updateUpstream
} from '../../src/lib/server/registry';
import { credentialLookingRef } from '../../src/lib/server/security/env-resolve';
import { renderManifest } from '../../src/lib/server/registry/manifest';
import { upstreams } from '../../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { uuidv7 } from '../../src/lib/shared/ids';
import { nowIso } from '../../src/lib/shared/time';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-ref-'));
const actor = { actorId: null, ip: '127.0.0.1' };

const CREDENTIALS = [
	'postgres://reader:hunter2@prod.internal:5432/app',
	'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'sk-abcdefghijklmnopqrstuvwxyz123456'
];

function make(slug: string, envRefs: Record<string, string> = {}) {
	return createUpstream(
		{ slug, name: slug, transport: 'stdio', connection: { command: 'true' }, envRefs },
		actor
	);
}

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '3'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	ensureLoaded(getDb());
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the detector only looks at literals', () => {
	test('references are never flagged — this is what keeps legitimate configs alive', () => {
		for (const ref of [
			'secret:pg-dev__database_url',
			'secret:my_key',
			'${SENTRY_URL}',
			'debug',
			'/data/app.db',
			'https://mcp.example.com/mcp',
			'-y'
		]) {
			expect(credentialLookingRef(ref)).toEqual([]);
		}
	});

	test('credentials are flagged', () => {
		for (const value of CREDENTIALS) expect(credentialLookingRef(value).length).toBeGreaterThan(0);
	});
});

describe('createUpstream refuses an inline credential', () => {
	for (const [index, value] of CREDENTIALS.entries()) {
		test(`rejected: ${value.slice(0, 24)}…`, () => {
			expect(() => make(`inline-create-${index}`, { DATABASE_URL: value })).toThrow(
				/credential appears to be written directly/
			);
		});
	}

	test('a header written inline is rejected too', () => {
		expect(() =>
			createUpstream(
				{
					slug: 'inline-header',
					name: 'inline-header',
					transport: 'http',
					connection: { url: 'https://mcp.internal/mcp' },
					headersRef: 'Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
				},
				actor
			)
		).toThrow(/inlined|credential/);
	});

	test('references and ordinary literals still pass — no false positives at the boundary', () => {
		// references are not required to resolve here: a manifest applied to an empty
		// box legitimately references secrets that do not exist yet (the upstream
		// simply reports "unconfigured" until they do)
		expect(() =>
			make('refs-ok', {
				DATABASE_URL: 'secret:pg-dev__database_url',
				SENTRY_DSN: '${SENTRY_DSN}',
				LOG_LEVEL: 'debug'
			})
		).not.toThrow();
	});
});

describe('updateUpstream refuses it as well', () => {
	test('rotating into an inline value is rejected, existing rows untouched', () => {
		const created = make('update-target', { LOG_LEVEL: 'debug' });
		let error: unknown;
		try {
			updateUpstream(created.id, { envRefs: { DATABASE_URL: CREDENTIALS[0] } }, actor);
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).code).toBe('inlined_secret');
		// a rejected write must leave the row exactly as it was
		const stored = getDb().select().from(upstreams).where(eq(upstreams.id, created.id)).get();
		expect(stored?.envRefs).toEqual({ LOG_LEVEL: 'debug' });
	});
});

describe('renderManifest refuses to export a credential', () => {
	test('a row with an inline value blocks export, and converting it unblocks export', () => {
		// simulating data that predates the boundary check: written straight to the
		// table, which is exactly the path the new guard exists to cover
		const db = getDb();
		const now = nowIso();
		const id = uuidv7();
		db.insert(upstreams)
			.values({
				id,
				slug: 'legacy-inline',
				name: 'legacy-inline',
				transport: 'stdio',
				enabled: true,
				connection: { command: 'true' },
				envRefs: { DATABASE_URL: CREDENTIALS[0] },
				timeoutMs: 60_000,
				pin: 'lazy',
				createdAt: now,
				updatedAt: now
			})
			.run();

		let error: unknown;
		try {
			renderManifest();
		} catch (cause) {
			error = cause;
		}
		expect((error as Error).message).toMatch(/legacy-inline/);
		expect((error as Error).message).not.toContain('hunter2'); // never echo the secret itself

		// convert it the way the operator would, then the export works again
		db.update(upstreams)
			.set({ envRefs: { DATABASE_URL: 'secret:legacy-inline__database_url' } })
			.where(eq(upstreams.id, id))
			.run();
		expect(renderManifest()).toContain('secret:legacy-inline__database_url');
	});
});
