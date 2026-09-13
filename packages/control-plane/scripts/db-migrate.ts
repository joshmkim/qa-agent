/**
 * Apply pending migrations to DATABASE_URL (the control plane also does this on boot).
 *
 *   pnpm --filter @qa-agent/control-plane db:migrate
 */
import "dotenv/config";
import postgres from "postgres";
import { migrate } from "../src/store/migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date.");
} finally {
  await sql.end({ timeout: 5 });
}
