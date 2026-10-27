/**
 * OAuth persistence schema (datadog-mcp-oauth todo 1).
 *
 * Locks the two tables, their primary keys, the one-pending-flow-per-upstream
 * unique index, the status lookup index, and the foreign keys the cleanup code
 * will rely on. Runs against a freshly migrated database so the migration — not
 * the Drizzle declarations — is what is actually proven.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { resetConfigCache } from '../../src/lib/server/config';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { getDb, getSqlite, useDatabaseForTests, type Db } from '../../src/lib/server/db';
import { schema } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';

let dir: string;
let db: Db;

type ColumnInfo = {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
};
type IndexListRow = { name: string; unique: number; origin: string; partial: number };
type IndexInfoRow = { seqno: number; cid: number; name: string };
type ForeignKeyRow = {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string | null;
	on_update: string;
	on_delete: string;
};

const columns = (table: string): ColumnInfo[] =>
	getSqlite().prepare(`pragma table_info(${table})`).all() as ColumnInfo[];

const indexes = (table: string): IndexListRow[] =>
	getSqlite().prepare(`pragma index_list(${table})`).all() as IndexListRow[];

const indexColumns = (index: string): string[] =>
	(getSqlite().prepare(`pragma index_info(${index})`).all() as IndexInfoRow[]).map(
		(row) => row.name
	);

const foreignKeys = (table: string): ForeignKeyRow[] =>
	getSqlite().prepare(`pragma foreign_key_list(${table})`).all() as ForeignKeyRow[];

const tableNames = (): string[] =>
	(
		getSqlite().prepare("select name from sqlite_master where type = 'table'").all() as Array<{
			name: string;
		}>
	).map((row) => row.name);

const UPSTREAM_OAUTH_COLUMNS = [
	'upstream_id',
	'status',
	'client_id',
	'client_secret_ref',
	'authorization_server_url',
	'resource_metadata_url',
	'authorization_endpoint',
	'token_endpoint',
	'registration_endpoint',
	'scopes',
	'discovery',
	'access_token_ref',
	'refresh_token_ref',
	'expires_at',
	'token_type',
	'granted_scope',
	'last_error',
	'connected_by',
	'connected_at',
	'created_at',
	'updated_at'
];

const UPSTREAM_OAUTH_PENDING_COLUMNS = [
	'state',
	'upstream_id',
	'verifier_sealed',
	'redirect_uri',
	'created_by',
	'created_at',
	'expires_at'
];

function insertUpstream(): string {
	const id = uuidv7();
	db.insert(schema.upstreams)
		.values({
			id,
			slug: `oauth-${id.slice(-8)}`,
			name: 'OAuth upstream',
			transport: 'http',
			connection: { url: 'https://mcp.example.test/mcp' }
		})
		.run();
	return id;
}

function insertPending(upstreamId: string, state = uuidv7()): string {
	getSqlite()
		.prepare(
			`insert into upstream_oauth_pending
				(state, upstream_id, verifier_sealed, redirect_uri, created_by, created_at, expires_at)
			 values (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			state,
			upstreamId,
			JSON.stringify({ cipher: 'c', iv: 'i', tag: 't', keyVer: 1 }),
			'https://gateway.example.test/oauth/callback',
			null,
			new Date().toISOString(),
			new Date(Date.now() + 60_000).toISOString()
		);
	return state;
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-schema-'));
	process.env.MCPGW_DATA_DIR = dir;
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('oauth migration', () => {
	test('creates both oauth tables', () => {
		const created = tableNames();
		expect(created).toContain('upstream_oauth');
		expect(created).toContain('upstream_oauth_pending');
	});

	test('upstream_oauth has every column and no plaintext credential column', () => {
		const names = columns('upstream_oauth').map((column) => column.name);
		expect(names).toEqual(UPSTREAM_OAUTH_COLUMNS);
		expect(names).not.toContain('access_token');
		expect(names).not.toContain('refresh_token');
		expect(names).not.toContain('code_verifier');
	});

	test('upstream_oauth uses upstream_id as its primary key', () => {
		const info = columns('upstream_oauth');
		const pk = info.filter((column) => column.pk > 0).map((column) => column.name);
		expect(pk).toEqual(['upstream_id']);
	});

	test('status is a not-null enum defaulting to disconnected', () => {
		const status = columns('upstream_oauth').find((column) => column.name === 'status');
		expect(status).toBeDefined();
		expect(status?.notnull).toBe(1);
		expect(status?.dflt_value).toBe("'disconnected'");
	});

	test('upstream_oauth_pending has every column and stores the sealed verifier as text', () => {
		const info = columns('upstream_oauth_pending');
		expect(info.map((column) => column.name)).toEqual(UPSTREAM_OAUTH_PENDING_COLUMNS);
		const verifier = info.find((column) => column.name === 'verifier_sealed');
		expect(verifier?.type.toLowerCase()).toBe('text');
		expect(verifier?.notnull).toBe(1);
	});

	test('upstream_oauth_pending uses state as its primary key', () => {
		const pk = columns('upstream_oauth_pending')
			.filter((column) => column.pk > 0)
			.map((column) => column.name);
		expect(pk).toEqual(['state']);
	});

	test('only one pending flow may exist per upstream', () => {
		const unique = indexes('upstream_oauth_pending').find(
			(index) => index.name === 'upstream_oauth_pending_upstream_idx'
		);
		expect(unique).toBeDefined();
		expect(unique?.unique).toBe(1);
		expect(indexColumns('upstream_oauth_pending_upstream_idx')).toEqual(['upstream_id']);
	});

	test('upstream_oauth has a status lookup index', () => {
		const status = indexes('upstream_oauth').find(
			(index) => index.name === 'upstream_oauth_status_idx'
		);
		expect(status).toBeDefined();
		expect(indexColumns('upstream_oauth_status_idx')).toEqual(['status']);
	});

	test('pending rows reference upstreams with a cascade delete', () => {
		const fk = foreignKeys('upstream_oauth_pending').find((row) => row.from === 'upstream_id');
		expect(fk).toBeDefined();
		expect(fk?.table).toBe('upstreams');
		expect(fk?.to).toBe('id');
		expect(fk?.on_delete).toBe('CASCADE');
	});

	test('upstream_oauth references upstreams and users with the declared delete actions', () => {
		const upstreamFk = foreignKeys('upstream_oauth').find((row) => row.from === 'upstream_id');
		expect(upstreamFk?.table).toBe('upstreams');
		expect(upstreamFk?.on_delete).toBe('CASCADE');

		const userFk = foreignKeys('upstream_oauth').find((row) => row.from === 'connected_by');
		expect(userFk?.table).toBe('users');
		expect(userFk?.on_delete).toBe('SET NULL');
	});

	test('exports both tables from the schema object', () => {
		expect(Object.keys(schema)).toContain('upstreamOauth');
		expect(Object.keys(schema)).toContain('upstreamOauthPending');
	});
});

describe('oauth referential integrity', () => {
	test('rejects a pending row whose upstream does not exist', () => {
		expect(() => insertPending(uuidv7())).toThrow();
	});

	test('deleting an upstream cascades its pending row', () => {
		const upstreamId = insertUpstream();
		const state = insertPending(upstreamId);
		db.delete(schema.upstreams).where(eq(schema.upstreams.id, upstreamId)).run();
		const remaining = getSqlite()
			.prepare('select state from upstream_oauth_pending where state = ?')
			.all(state) as Array<{ state: string }>;
		expect(remaining).toHaveLength(0);
	});
});
