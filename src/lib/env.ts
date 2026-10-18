import "server-only";

import { serverEnvSchema } from "@/lib/env-schema";

export function getServerEnv() {
  return serverEnvSchema.parse({ DATABASE_URL: process.env.DATABASE_URL });
}
