import { config } from "dotenv";
import type { Config } from "drizzle-kit";

// Drizzle Kit doesn't auto-load .env.local the way Next.js does. Load it
// explicitly so npm run db:push / db:migrate / db:studio see DATABASE_URL.
config({ path: ".env.local" });

export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
