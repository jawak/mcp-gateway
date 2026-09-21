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
			adapter: adapter()
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
