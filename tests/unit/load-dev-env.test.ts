import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDevEnv, resetDevEnvReport } from '../../scripts/load-dev-env';

/**
 * `.env` loading for the dev server.
 *
 * The regression this locks down was invisible from inside the codebase: every other
 * entrypoint (`bun file.ts`, `bun test`, the built server) gets `.env` from Bun, so the
 * only way to see the failure is to start the dev server with nothing but a `.env`
 * file — which is exactly what a new operator does first.
 */
function tempProject(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-env-'));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(dir, name), content);
	}
	return dir;
}

/**
 * `bun test` auto-loads the repository's own `.env`, and Vite's `loadEnv` gives the
 * process environment priority over the files it reads. Both facts have to be
 * neutralised or a developer's local values decide whether these tests pass — which is
 * the same trap that hid the original bug.
 */
async function withIsolatedEnv<T>(names: string[], run: () => Promise<T> | T): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const name of names) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	try {
		return await run();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe('loadDevEnv', () => {
	// the startup sentence prints once per process, which the assertions here depend on
	beforeEach(() => resetDevEnvReport());

	test('applies values named in .env', async () => {
		const dir = tempProject({ '.env': 'MCPGW_MASTER_KEY=from-file\nMCPGW_PORT=9999\n' });
		try {
			await withIsolatedEnv(['MCPGW_MASTER_KEY', 'MCPGW_PORT'], () => {
				const env: Record<string, string | undefined> = {};
				const result = loadDevEnv({ mode: 'test', cwd: dir, env });
				expect(env.MCPGW_MASTER_KEY).toBe('from-file');
				expect(env.MCPGW_PORT).toBe('9999');
				expect(result.applied).toContain('MCPGW_MASTER_KEY');
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the startup line is printed once per process, not once per config load', () => {
		const dir = tempProject({ '.env': 'MCPGW_MASTER_KEY=abc\n' });
		try {
			const messages: string[] = [];
			loadDevEnv({ mode: 'test', cwd: dir, env: {}, log: (m) => messages.push(m) });
			loadDevEnv({ mode: 'test', cwd: dir, env: {}, log: (m) => messages.push(m) });
			// vite evaluates the config file several times per build; repeating the
			// sentence buries it in output nobody reads
			expect(messages).toHaveLength(1);
		} finally {
			resetDevEnvReport();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a value already in the environment wins over the file', () => {
		const dir = tempProject({ '.env': 'MCPGW_ADMIN_EMAIL=file@example.com\n' });
		try {
			const env: Record<string, string | undefined> = { MCPGW_ADMIN_EMAIL: 'shell@example.com' };
			const result = loadDevEnv({ mode: 'test', cwd: dir, env });
			// a container or systemd environment must never be silently overridden by a
			// stale file left in the image
			expect(env.MCPGW_ADMIN_EMAIL).toBe('shell@example.com');
			expect(result.preserved).toContain('MCPGW_ADMIN_EMAIL');
			expect(result.applied).not.toContain('MCPGW_ADMIN_EMAIL');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a blank value is left unset, not applied as an empty string', () => {
		const dir = tempProject({ '.env': 'MCPGW_METRICS_TOKEN=\nMCPGW_SET=kept\n' });
		try {
			const env: Record<string, string | undefined> = {};
			loadDevEnv({ mode: 'test', cwd: dir, env });
			// blank means "not configured"; assigning '' would make it look deliberate
			expect(env.MCPGW_METRICS_TOKEN).toBeUndefined();
			expect(env.MCPGW_SET).toBe('kept');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('.env.local overrides .env, matching Vite precedence', async () => {
		const dir = tempProject({
			'.env': 'MCPGW_PORT=1111\n',
			'.env.local': 'MCPGW_PORT=2222\n'
		});
		try {
			await withIsolatedEnv(['MCPGW_PORT'], () => {
				const env: Record<string, string | undefined> = {};
				loadDevEnv({ mode: 'test', cwd: dir, env });
				expect(env.MCPGW_PORT).toBe('2222');
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('comments and shell keywords are handled, secrets-shaped lines are not', () => {
		const dir = tempProject({
			'.env': '# MCPGW_COMMENTED=nope\nexport MCPGW_EXPORTED=yes\nMCPGW_PLAIN=ok\n'
		});
		try {
			const env: Record<string, string | undefined> = {};
			loadDevEnv({ mode: 'test', cwd: dir, env });
			expect(env.MCPGW_COMMENTED).toBeUndefined();
			expect(env.MCPGW_EXPORTED).toBe('yes');
			expect(env.MCPGW_PLAIN).toBe('ok');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('no .env file is not an error', () => {
		const dir = tempProject({ 'package.json': '{}' });
		try {
			const messages: string[] = [];
			const env: Record<string, string | undefined> = {};
			const result = loadDevEnv({
				mode: 'test',
				cwd: dir,
				env,
				log: (m) => messages.push(m)
			});
			expect(result.applied).toEqual([]);
			expect(messages.join('')).toContain('no .env file found');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the startup line names the files and where the master key came from', async () => {
		const dir = tempProject({ '.env': 'MCPGW_MASTER_KEY=abc\n' });
		try {
			await withIsolatedEnv(['MCPGW_MASTER_KEY'], () => {
				const messages: string[] = [];
				loadDevEnv({ mode: 'test', cwd: dir, env: {}, log: (m) => messages.push(m) });
				const line = messages.join('');
				expect(line).toContain('[env] read .env');
				expect(line).toContain('MCPGW_MASTER_KEY from file');
				// the question that prompted this whole fix must be answerable from the log
				expect(line).not.toMatch(/undefined/);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('variables that exist only in the environment are neither applied nor reported', async () => {
		const dir = tempProject({ '.env': 'MCPGW_REAL=1\n' });
		try {
			await withIsolatedEnv(['MCPGW_REAL'], () => {
				const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
				const result = loadDevEnv({ mode: 'test', cwd: dir, env });
				// loadEnv with an empty prefix echoes all of process.env; reporting that
				// as "from the file" would claim hundreds of variables were loaded
				expect(result.applied).toEqual(['MCPGW_REAL']);
				expect(result.preserved).toEqual([]);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the client bundle must never see MCPGW_* (guard)', () => {
	const config = readFileSync(path.resolve(import.meta.dirname, '../../vite.config.ts'), 'utf8');

	test('vite.config loads .env before the server modules are imported', () => {
		expect(config).toMatch(/loadDevEnv\(/);
	});

	test('envPrefix stays at VITE_ so server secrets are not inlined into the browser', () => {
		// `envPrefix: ''` would publish MCPGW_MASTER_KEY in the client bundle.
		const match = /envPrefix:\s*'([^']*)'/.exec(config);
		expect(match?.[1]).toBe('VITE_');
	});
});
