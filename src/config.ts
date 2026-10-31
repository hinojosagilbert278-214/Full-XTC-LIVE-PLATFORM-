import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("xtc-identity"),
  JWT_AUDIENCE: z.string().default("xtc-wallet"),
  WEBHOOK_SIMULATION: z.enum(["true", "false"]).default("false"),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  REVENUECAT_WEBHOOK_AUTH: z.string().optional(),
  APPLE_ROOT_CA_PEM: z.string().optional(),
  GOOGLE_PUBSUB_AUDIENCE: z.string().optional(),
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
});
export type Config = z.infer<typeof schema> & { simulation: boolean };

/** Fails fast at startup. Simulation mode is refused in production so fake events can never issue coins there. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const c = schema.parse(env);
  if (c.NODE_ENV === "production" && c.WEBHOOK_SIMULATION === "true")
    throw new Error("WEBHOOK_SIMULATION must not be enabled in production");
  return { ...c, simulation: c.WEBHOOK_SIMULATION === "true" };
}
