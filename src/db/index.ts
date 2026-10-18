import "server-only";

import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { getServerEnv } from "@/lib/env";
import * as schema from "@/db/schema";

export function createDbPool() {
  return new Pool({ connectionString: getServerEnv().DATABASE_URL, max: 1 });
}

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(pool: Pool) {
  return drizzle(pool, { schema });
}

export async function withDatabase<T>(operation: (db: Database) => Promise<T>): Promise<T> {
  const pool = createDbPool();
  try {
    return await operation(createDatabase(pool));
  } finally {
    await pool.end();
  }
}
