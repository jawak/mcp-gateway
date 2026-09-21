/**
 * Bundles the Bun entrypoints to build/server.js + build/worker.js (T-02).
 *
 * Runs after `vite build`. @sveltejs/kit, runtime dependencies and the runtime
 * resolved build artifacts stay external — same externalisation strategy
 * `@sveltejs/adapter-node` uses with rollup.
 */
import { exit } from 'node:process';

const shared = {
	entrypoints: ['src/entrypoints/server.ts', 'src/entrypoints/worker.ts'],
	outdir: 'build',
	target: 'bun' as const,
	format: 'esm' as const,
	splitting: false,
	sourcemap: 'linked' as const,
	external: [
		'@sveltejs/kit',
		'@sveltejs/kit/*',
		'@sveltejs/adapter-node/*',
		'bun:sqlite',
		'node:*',
		// server.ts resolves these at runtime from .svelte-kit/output
		'../.svelte-kit/output/server/index.js',
		'../.svelte-kit/output/server/manifest.js'
	]
};

const result = await Bun.build(shared);
for (const log of result.logs) console.error(log);
if (!result.success) {
	console.error('build:server failed');
	exit(1);
}
console.log(`bundled ${result.outputs.length} entrypoints to build/`);
