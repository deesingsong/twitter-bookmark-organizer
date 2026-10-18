export const LOCAL_E2E_ORIGIN = "http://127.0.0.1:3100";

const NEON_ENDPOINT = /^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/;
const SAFE_QUERY_OPTIONS = new Set(["sslmode", "channel_binding", "connect_timeout", "application_name"]);

interface LocalE2ETarget {
  appConnectionString: string;
  directConnectionString: string;
}

function databaseUrl(value: string | undefined, name: string): URL {
  if (!value) throw new Error(`Local E2E requires ${name} for the development-only bookmark_dev database.`);
  let url: URL;
  try {
    url = new URL(value);
    // The driver decodes credentials; fail here without including them in errors.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new Error(`Local E2E requires a valid PostgreSQL URL in ${name}.`);
  }
  const hostname = url.hostname.toLowerCase();
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !NEON_ENDPOINT.test(hostname)
    || url.pathname !== "/bookmark_dev"
    || (url.port && url.port !== "5432")
    || !url.username || !url.password || url.hash) {
    throw new Error(`Local E2E restricts ${name} to an authenticated Neon bookmark_dev connection on port 5432.`);
  }
  for (const option of url.searchParams.keys()) {
    // The PostgreSQL driver accepts query options such as ?host= that replace
    // the hostname inspected above. Accept only the normal Neon URL options.
    if (!SAFE_QUERY_OPTIONS.has(option) || url.searchParams.getAll(option).length !== 1) {
      throw new Error(`Local E2E rejects unsupported or repeated connection options in ${name}.`);
    }
  }
  if (!["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")) {
    throw new Error(`Local E2E requires TLS in ${name}.`);
  }
  url.hostname = hostname;
  // Avoid an inherited PGPORT changing a URL that omits its default port.
  url.port = "5432";
  return url;
}

export function requireLocalE2ETarget(environment: Record<string, string | undefined> = process.env): LocalE2ETarget {
  const direct = databaseUrl(environment.DATABASE_URL_UNPOOLED, "DATABASE_URL_UNPOOLED");
  const app = databaseUrl(environment.DATABASE_URL, "DATABASE_URL");
  if (direct.hostname.includes("-pooler")
    || app.hostname.replace("-pooler.", ".") !== direct.hostname) {
    throw new Error("Local E2E requires matching application and direct development-only Neon endpoints.");
  }
  return { appConnectionString: app.href, directConnectionString: direct.href };
}
