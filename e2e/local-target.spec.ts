import { expect, test } from "@playwright/test";
import { LOCAL_E2E_ORIGIN, requireLocalE2ETarget } from "./local-target";

const directUrl = "postgresql://synthetic_owner:synthetic_password@ep-e2e-synthetic.c-1.ap-southeast-1.aws.neon.tech/bookmark_dev?sslmode=require&channel_binding=require";
const pooledUrl = directUrl.replace("ep-e2e-synthetic.", "ep-e2e-synthetic-pooler.");
const environment = { DATABASE_URL: pooledUrl, DATABASE_URL_UNPOOLED: directUrl };

test("local E2E uses an explicit loopback origin and matching secure Neon URLs", () => {
  expect(LOCAL_E2E_ORIGIN).toBe("http://127.0.0.1:3100");
  const target = requireLocalE2ETarget(environment);
  expect(new URL(target.appConnectionString).port).toBe("5432");
  expect(new URL(target.directConnectionString).port).toBe("5432");
  expect(new URL(target.appConnectionString).searchParams.get("channel_binding")).toBe("require");
  // A direct application URL is also a valid development target.
  expect(() => requireLocalE2ETarget({ ...environment, DATABASE_URL: directUrl })).not.toThrow();
});

test("local E2E rejects absent, non-development, or insecure database URLs", async () => {
  const invalidUrls: (string | undefined)[] = [
    undefined,
    "not-a-postgresql-url",
    directUrl.replace("postgresql:", "https:"),
    directUrl.replace("bookmark_dev", "bookmark_prod"),
    directUrl.replace("bookmark_dev", "%62ookmark_dev"),
    directUrl.replace(".neon.tech", ".neon.tech.example.test"),
    directUrl.replace(".neon.tech/", ".neon.tech:5433/"),
    directUrl.replace("sslmode=require", "sslmode=disable"),
    directUrl.replace("?sslmode=require&channel_binding=require", ""),
    directUrl.replace("synthetic_owner:synthetic_password@", ""),
    `${directUrl}#untrusted-fragment`,
  ];
  for (const [index, url] of invalidUrls.entries()) {
    await test.step(`invalid target ${index + 1} is rejected for either connection`, async () => {
      expect(() => requireLocalE2ETarget({ ...environment, DATABASE_URL: url })).toThrow(/Local E2E/);
      expect(() => requireLocalE2ETarget({ ...environment, DATABASE_URL_UNPOOLED: url })).toThrow(/Local E2E/);
    });
  }
});

test("local E2E rejects a pooled direct URL and mismatched endpoints", () => {
  expect(() => requireLocalE2ETarget({ ...environment, DATABASE_URL_UNPOOLED: pooledUrl })).toThrow(/matching/);
  expect(() => requireLocalE2ETarget({
    ...environment,
    DATABASE_URL: pooledUrl.replace("ep-e2e-synthetic-pooler", "ep-other-endpoint-pooler"),
  })).toThrow(/matching/);
});

test("local E2E blocks driver query overrides while keeping normal Neon options", async () => {
  const overrides = [
    "host=production.example.test",
    "database=bookmark_prod",
    "user=other_owner",
    "password=other_password",
    "port=5433",
    "sslmode=disable",
    "sslrootcert=private-file.pem",
  ];
  for (const option of overrides) {
    await test.step(option.split("=")[0], async () => {
      expect(() => requireLocalE2ETarget({ ...environment, DATABASE_URL: `${pooledUrl}&${option}` })).toThrow(/connection options/);
      expect(() => requireLocalE2ETarget({ ...environment, DATABASE_URL_UNPOOLED: `${directUrl}&${option}` })).toThrow(/connection options/);
    });
  }
  expect(() => requireLocalE2ETarget({
    DATABASE_URL: `${pooledUrl}&application_name=synthetic-e2e&connect_timeout=10`,
    DATABASE_URL_UNPOOLED: `${directUrl}&application_name=synthetic-e2e&connect_timeout=10`,
  })).not.toThrow();
});

test("local E2E configuration errors omit connection credentials", () => {
  try {
    requireLocalE2ETarget({ ...environment, DATABASE_URL: pooledUrl.replace("bookmark_dev", "bookmark_prod") });
    throw new Error("Expected the production database URL to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Local E2E/);
    expect((error as Error).message).not.toContain("synthetic_owner");
    expect((error as Error).message).not.toContain("synthetic_password");
    expect((error as Error).message).not.toContain("postgresql://");
  }
});
