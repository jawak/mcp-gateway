import { defineConfig } from 'drizzle-kit';

/**
 * `bun run db:generate` writes SQL to ./drizzle, `db:migrate` applies it.
 * The runtime applies migrations itself (src/lib/server/db/migrate.ts), so this
 * file only drives the CLI.
 */
export default defineConfig({
	dialect: 'sqlite',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	strict: true
});
