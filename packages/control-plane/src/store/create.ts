import postgres from "postgres";
import type { Store } from "./index";
import { MemoryStore } from "./memory";
import { migrate } from "./migrate";
import { PostgresStore } from "./postgres";

export interface StoreHandle {
  store: Store;
  /** Close connections; safe to call more than once. */
  close: () => Promise<void>;
}

/** Postgres when DATABASE_URL is set (migrated on boot), otherwise in-memory. */
export async function createStore(env: NodeJS.ProcessEnv = process.env): Promise<StoreHandle> {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    console.log("[store] in-memory (DATABASE_URL not set); data is lost on restart");
    return { store: new MemoryStore(), close: async () => {} };
  }

  const sql = postgres(url, { max: 10, onnotice: () => {} });
  try {
    const applied = await migrate(sql);
    const where = new URL(url);
    console.log(
      `[store] postgres ${where.hostname}:${where.port || 5432}${where.pathname}` +
        (applied.length ? ` (applied migrations: ${applied.join(", ")})` : ""),
    );
  } catch (err) {
    await sql.end({ timeout: 1 });
    throw new Error(`Could not connect to or migrate DATABASE_URL: ${(err as Error).message}`);
  }

  let closed = false;
  return {
    store: new PostgresStore(sql),
    close: async () => {
      if (closed) return;
      closed = true;
      await sql.end({ timeout: 5 });
    },
  };
}
