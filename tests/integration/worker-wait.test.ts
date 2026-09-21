import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/lib/server/db/migrate';

/**
 * The worker must wait for the gateway to migrate rather than sweeping a schema
 * that does not exist (T-44 plan, phase 5). `migrate.ts` has claimed this behaviour
 * in its docstring since T-04; these tests are what make the claim true.
 */
const repoRoot = path.resolve(import.meta.dirname, '../..');
const workerEntry = path.join(repoRoot, 'src/entrypoints/worker.ts');

function baseEnv(dataDir: string, waitSeconds: string): Record<string, string> {
	return {
		...process.env,
		MCPGW_DATA_DIR: dataDir,
		MCPGW_MASTER_KEY: 'a'.repeat(64),
		MCPGW_WORKER_WAIT_S: waitSeconds,
		MCPGW_PUBLIC_URL: 'https://worker.test',
		NODE_ENV: 'production'
	};
}

async function runWorker(
	dataDir: string,
	waitSeconds: string,
	opts: { killAfterMs?: number } = {}
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	// --no-env-file: a developer's own .env must never decide whether a test passes
	const child = Bun.spawn([process.execPath, '--no-env-file', 'run', workerEntry], {
		cwd: repoRoot,
		env: baseEnv(dataDir, waitSeconds) as NodeJS.ProcessEnv,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	if (opts.killAfterMs) {
		setTimeout(() => child.kill('SIGTERM'), opts.killAfterMs);
	}
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text()
	]);
	return { exitCode: await child.exited, stdout, stderr };
}

describe('worker refuses to run against an unmigrated database', () => {
	test('exits non-zero after its wait timeout and writes nothing', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-worker-wait-'));
		try {
			const result = await runWorker(dir, '2');
			expect(result.exitCode).toBe(1);
			const output = result.stdout + result.stderr;
			expect(output).toMatch(/not migrated|giving up/i);
			// no snapshot directory, no half-written backups
			expect(existsSync(path.join(dir, 'backups'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test('proceeds once the schema exists and shuts down cleanly on SIGTERM', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-worker-go-'));
		try {
			runMigrations({ dataDir: dir });
			const result = await runWorker(dir, '5', { killAfterMs: 1_500 });
			const output = result.stdout + result.stderr;
			expect(output).toMatch(/worker started/);
			expect(output).not.toMatch(/giving up/);
			expect(result.exitCode).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 40_000);

	test('a migrated-but-old schema still blocks the mutating jobs', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-worker-old-'));
		try {
			// migrate, then rewind the recorded version: readiness must be about the
			// recorded schema version, not merely "some tables exist"
			const { db } = runMigrations({ dataDir: dir });
			const { setKv } = await import('../../src/lib/server/db/migrate');
			setKv(db, 'schema_version', '0');
			const result = await runWorker(dir, '2');
			expect(result.exitCode).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
