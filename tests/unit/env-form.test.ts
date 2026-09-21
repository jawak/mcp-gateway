/**
 * Reference parsing for the upstream form (T-32). These are the same rules the
 * manifest enforces, so the UI must not be the easier way to inline a token.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normaliseRef, parseEnvLines, rowsToRefs } from '../../src/lib/server/registry/env-form';
import { RegistryError } from '../../src/lib/server/registry';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { useDatabaseForTests } from '../../src/lib/server/db';

const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-envform-'));

beforeAll(() => {
	process.env.SMOKE_PRESENT = 'yes';
	// secret references resolve against the vault, so the suite needs a database
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '4'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

describe('parseEnvLines', () => {
	test('accepts NAME=value lines and ignores blanks and comments', () => {
		const parsed = parseEnvLines('# comment\n\nA=1\nB=two\n');
		expect(parsed.errors).toEqual([]);
		expect(parsed.rows).toEqual([
			{ env: 'A', ref: '1' },
			{ env: 'B', ref: 'two' }
		]);
	});

	test('reports the line number of anything malformed', () => {
		const parsed = parseEnvLines('A=1\nnot a pair\nB=2');
		expect(parsed.errors).toHaveLength(1);
		expect(parsed.errors[0]).toContain('line 2');
	});

	test('lower-case names are rejected (env vars are upper case by convention)', () => {
		expect(parseEnvLines('lower=1').errors).toHaveLength(1);
	});
});

describe('normaliseRef', () => {
	test('accepts a set host variable and keeps the ${VAR} form', () => {
		expect(normaliseRef('TOKEN', '${SMOKE_PRESENT}')).toBe('${SMOKE_PRESENT}');
	});

	test('a host variable that is not set is refused with its name', () => {
		expect(() => normaliseRef('TOKEN', '${SMOKE_DEFINITELY_MISSING}')).toThrow(
			/SMOKE_DEFINITELY_MISSING/
		);
	});

	test('refuses a value that looks like a credential', () => {
		let message = '';
		try {
			normaliseRef('GH_TOKEN', 'ghp_A1b2C3d4E5f6G7h8I9j0K1L2');
		} catch (error) {
			message = (error as RegistryError).message;
		}
		expect(message).toMatch(/looks like a credential/);
		expect(message).toMatch(/secret:<name>/);
	});

	test('allows ordinary literal configuration', () => {
		expect(normaliseRef('LOG_LEVEL', 'debug')).toBe('debug');
	});

	test('rejects an empty value and enforces the no-literal mode', () => {
		expect(() => normaliseRef('X', '')).toThrow(/cannot be empty|give a value/);
		expect(() => normaliseRef('X', 'plain', { allowLiteral: false })).toThrow(/ENV_VAR|secret:/);
	});

	test('an unknown secret reference is refused rather than left dangling', () => {
		expect(() => normaliseRef('X', 'secret:never-created-secret')).toThrow(/does not exist/);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe('rowsToRefs', () => {
	test('maps every row and keeps the env names', () => {
		const refs = rowsToRefs(parseEnvLines('LOG_LEVEL=debug\nTOKEN=${SMOKE_PRESENT}').rows);
		expect(refs).toEqual({ LOG_LEVEL: 'debug', TOKEN: '${SMOKE_PRESENT}' });
	});
});
