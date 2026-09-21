import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
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
	}
});
