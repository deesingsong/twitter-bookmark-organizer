import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";
import { z } from "zod";

config({ path: ".env.local" });

const databaseUrl = z.string().url().startsWith("postgres").parse(process.env.DATABASE_URL);
const migrationUrl = z.string().url().startsWith("postgres").parse(
  process.env.DATABASE_URL_UNPOOLED ?? databaseUrl,
);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Drizzle migrations need a direct connection; the pooled URL is for app traffic.
  dbCredentials: { url: migrationUrl },
  strict: true,
  verbose: true,
});
