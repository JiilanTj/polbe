import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

// Connection pool — reuses connections, no open/close overhead per query
const pool = postgres(config.database.url, {
  max: 20,               // max connections in pool
  idle_timeout: 30,      // close idle connections after 30s
  connect_timeout: 10,   // timeout for new connections
});

export const db = drizzle(pool, { schema });

// For graceful shutdown
export async function closeDb() {
  await pool.end();
}
