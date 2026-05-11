import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

let cached: DrizzleClient | null = null;

function init(): DrizzleClient {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Provision Neon via the Vercel Marketplace and copy the pooled connection string into .env.local. See .env.example.",
    );
  }
  const sql = neon(url);
  cached = drizzle({ client: sql, schema });
  return cached;
}

// Lazy proxy so importing this module does not require DATABASE_URL at build
// time. The throw fires only on first actual use.
export const db = new Proxy({} as DrizzleClient, {
  get(_target, prop, receiver) {
    return Reflect.get(init() as object, prop, receiver);
  },
}) as DrizzleClient;

export { schema };
