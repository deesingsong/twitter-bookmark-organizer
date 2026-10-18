import { z } from "zod";

export const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgres"),
});
