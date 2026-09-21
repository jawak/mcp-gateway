/**
 * Load `.env` files for the dev server (T-44 follow-up).
 *
 * Bun loads `.env` for the entrypoint it runs directly (`bun file.ts`, `bun -e`,
 * `bun test`), but `bun run dev` hands off to `vite`, and Vite/SvelteKit never copy
 * `.env` into `process.env` — they only expose `VITE_*`-prefixed values to the browser
 * through `import.meta.env`. Every value this gateway reads lives in `process.env`, so
 * in development the whole configuration silently appeared unset: no master key, no
 * admin bootstrap, no public URL.
 *
 * Fixing it here rather than in a shell wrapper means it works for `bun run dev`,
 * `npx vite dev`, `pnpm dev`, and IDE launchers alike.
 *
 * Rules:
 *  - a value already in the environment always wins, so a real shell, systemd unit or
 *    container environment overrides the file rather than being overridden by it;
 *  - only variables named in the files are considered. `loadEnv` is called with an
 *    empty prefix and therefore echoes the *entire* `process.env` back — treating that
 *    as "from the file" would report the developer's whole environment as loaded and
 *    log hundreds of meaningless lines;
 *  - blank values are skipped, matching config's "blank means unset";
 *  - only `process.env` is touched. Nothing here reaches Vite's client-visible
 *    surface, which is governed by `envPrefix` (kept at `VITE_`), so no `MCPGW_*`
 *    value can be inlined into a browser bundle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadEnv } from 'vite';

export type LoadDevEnvOptions = {
	mode?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	log?: (message: string) => void;
};

export type LoadDevEnvResult = {
	/** Variables taken from the files. */
	applied: string[];
	/** Variables named in the files but already set in the environment. */
	preserved: string[];
	/** Files that were read, in increasing order of precedence. */
	sources: string[];
};

let reported = false;

/**
 * Allow the startup line to be printed again.
 *
 * Exists for tests, which assert the sentence itself; production code should never
 * need it, since "print once per process" is exactly the behaviour wanted.
 */
export function resetDevEnvReport(): void {
	reported = false;
}

export function loadDevEnv(options: LoadDevEnvOptions = {}): LoadDevEnvResult {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const mode = options.mode ?? env.NODE_ENV ?? 'development';
	const sources = sourcesFor(mode, cwd);
	// Vite evaluates the config file several times per build, and after the first pass
	// the values are already in `process.env`, so every later pass would print the same
	// sentence again. A startup line worth reading is a startup line printed once.
	const log = options.log && !reported ? options.log : undefined;
	if (options.log) reported = true;

	if (sources.length === 0) {
		log?.('[env] no .env file found — using the environment only');
		return { applied: [], preserved: [], sources };
	}

	// Values come from Vite so quoting and expansion match what Vite itself does;
	// the *names* come from the files, because the empty prefix makes `loadEnv`
	// return every variable in the process environment as well.
	const values = loadEnv(mode, cwd, '');
	const applied: string[] = [];
	const preserved: string[] = [];
	for (const name of namedInFiles(sources)) {
		if (env[name] !== undefined) {
			preserved.push(name);
			continue;
		}
		const value = values[name];
		if (value === undefined || value === '') continue;
		env[name] = value;
		applied.push(name);
	}

	log?.(summarise(applied, preserved, sources, cwd));
	return { applied, preserved, sources };
}

/** Files Vite would read for this mode, lowest precedence first. */
function sourcesFor(mode: string, cwd: string): string[] {
	return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
		.map((name) => join(cwd, name))
		.filter((file) => existsSync(file));
}

/**
 * Variable names declared in the given files.
 *
 * Deliberately not a dotenv parser: it only needs names, and a name on a line that
 * dotenv would not accept simply means we do not load it — Vite stays the authority on
 * what a valid assignment is.
 */
function namedInFiles(files: string[]): string[] {
	const names = new Set<string>();
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split(/\r?\n/)) {
			const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
			if (match && !/^\s*#/.test(line)) names.add(match[1]);
		}
	}
	return [...names];
}

function summarise(applied: string[], preserved: string[], sources: string[], cwd: string): string {
	const files = sources.map((file) => relative(cwd, file) || file).join(', ');
	const key = applied.includes('MCPGW_MASTER_KEY')
		? 'MCPGW_MASTER_KEY from file'
		: process.env.MCPGW_MASTER_KEY
			? 'MCPGW_MASTER_KEY from the environment'
			: 'MCPGW_MASTER_KEY NOT SET (sealed secrets will not survive a restart)';
	return [
		`[env] read ${files}`,
		`${applied.length} variable(s) applied`,
		preserved.length ? `${preserved.length} already set, kept` : null,
		key
	]
		.filter(Boolean)
		.join(' · ');
}
