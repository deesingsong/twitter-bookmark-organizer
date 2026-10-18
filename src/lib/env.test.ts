import { afterEach, describe, expect, it } from "vitest";
import { serverEnvSchema } from "./env-schema";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("server environment", () => {
  it("accepts a PostgreSQL connection URL", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost/app";
    expect(serverEnvSchema.parse({ DATABASE_URL: process.env.DATABASE_URL }).DATABASE_URL)
      .toBe("postgresql://user:pass@localhost/app");
  });

  it("rejects missing and non-PostgreSQL URLs", () => {
    delete process.env.DATABASE_URL;
    expect(() => serverEnvSchema.parse({ DATABASE_URL: process.env.DATABASE_URL })).toThrow();
    process.env.DATABASE_URL = "https://example.com";
    expect(() => serverEnvSchema.parse({ DATABASE_URL: process.env.DATABASE_URL })).toThrow();
  });
});
