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
  ADMIN_DATABASE_URL: z.string().optional(),      // login that is a member of xtc_admin (policy approval, holds, freezes)
  WORKER_DATABASE_URL: z.string().optional(),     // login that is a direct member of xtc_provider_worker (records provider evidence)
  MIGRATION_DATABASE_URL: z.string().optional(),  // owner credentials, used only by `npm run migrate`
  REDIS_URL: z.string().optional(),
  ALLOW_LOCAL_RATE_LIMIT: z.enum(["true", "false"]).default("false"),
  PAYOUT_PROVIDER: z.enum(["simulation", "stripe"]).default("simulation"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_API_BASE: z.string().default("https://api.stripe.com"),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
});
export type Config = z.infer<typeof schema> & { simulation: boolean };

/** Fails fast at startup. Simulation mode is refused in production so fake events can never issue coins there. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const c = schema.parse(env);
  if (c.NODE_ENV === "production" && c.WEBHOOK_SIMULATION === "true")
    throw new Error("WEBHOOK_SIMULATION must not be enabled in production");
  if (c.NODE_ENV === "production" && c.PAYOUT_PROVIDER === "simulation")
    throw new Error("PAYOUT_PROVIDER=simulation is not allowed in production");
  if (c.NODE_ENV === "production" && !c.WORKER_DATABASE_URL) throw new Error("WORKER_DATABASE_URL is required in production (provider evidence must be recorded by a dedicated worker login)");
  if (c.PAYOUT_PROVIDER === "stripe" && !c.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is required when PAYOUT_PROVIDER=stripe");
  if (c.NODE_ENV === "production" && !c.REDIS_URL && c.ALLOW_LOCAL_RATE_LIMIT !== "true")
    throw new Error("REDIS_URL is required in production (per-instance rate limits are not enforceable across instances)");
  return { ...c, simulation: c.WEBHOOK_SIMULATION === "true" };
}
