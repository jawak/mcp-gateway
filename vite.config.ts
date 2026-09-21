import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadDevEnv } from './scripts/load-dev-env.ts';

export default defineConfig(({ mode }) => {
	// Must happen before anything imports the server modules: the config layer reads
	// `process.env` at import time, and `.env` never reaches `process.env` on its own
	// when the dev server was started through `bunx`/`npx`. See the module docstring.
	loadDevEnv({ mode, log: (message) => console.log(message) });

	return {
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter: adapter(),
				/**
				 * SvelteKit renders an inline bootstrap `<script>`. With `mode: 'nonce'`
				 * Kit adds its own nonce to the header built from these directives —
				 * setting the header by hand instead leaves that script unlicensed, which
				 * breaks hydration only in production, where no test looks.
				 */
				csp: {
					mode: 'nonce',
					// Kit adds the quotes these render as; keep in sync with
					// cspDirectives() in src/lib/server/governance/rbac.ts (asserted there)
					directives: {
						'default-src': ['self'],
						'script-src': ['self'],
						'style-src': ['self', 'unsafe-inline'],
						'img-src': ['self', 'data:'],
						'font-src': ['self', 'data:'],
						'connect-src': ['self'],
						'frame-ancestors': ['none'],
						'base-uri': ['self'],
						'form-action': ['self']
					}
				}
			})
		],
		build: {
			rollupOptions: {
				// entrypoints are bundled by scripts/build-server.ts, and @sveltejs/kit
				// must stay external so the bundled server shares one module instance
				external: ['@sveltejs/kit', '@sveltejs/kit/*', '@sveltejs/adapter-node/*']
			}
		},
		/**
		 * Left at Vite's default on purpose. Only variables matching this prefix are
		 * inlined into client code, which is what keeps the `MCPGW_*` values that
		 * `loadDevEnv` puts into `process.env` on the server. Setting this to `''`
		 * would publish the master key in the browser bundle — there is a test
		 * guarding it (tests/unit/load-dev-env.test.ts).
		 */
		envPrefix: 'VITE_'
	};
});
