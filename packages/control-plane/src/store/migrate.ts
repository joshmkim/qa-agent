import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** Arbitrary constant; serializes migrations across instances booting together. */
const MIGRATION_LOCK_KEY = 7_420_311;

/**
 * Applies `migrations/*.sql` in filename order. Each file runs in its own
 * transaction under a transaction-scoped advisory lock and is recorded in
 * schema_migrations, so re-running is a no-op and concurrent boots don't race.
 * Returns the versions applied by this call.
 */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  // CREATE TABLE IF NOT EXISTS races on the catalog when two connections run
  // it at once, so it takes the same lock as the migrations themselves.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  });

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const didApply = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      const [done] = await tx`SELECT 1 FROM schema_migrations WHERE version = ${version}`;
      if (done) return false;
      await tx.unsafe(readFileSync(join(dir, file), "utf8"));
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
      return true;
    });
    if (didApply) applied.push(version);
  }
  return applied;
}
