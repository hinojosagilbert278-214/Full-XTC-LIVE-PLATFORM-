import { loadConfig } from "./config";
import { PgDb, migrate, assertLeastPrivilege } from "./db/pg";
import { createApp } from "./api/app";
import { webhookRoutes, startWorker } from "./webhooks/service";
import { payoutRoutes } from "./payouts/routes";
import { startPayoutWorker } from "./payouts/service";
import { SimulatedProvider, StripeConnectProvider } from "./payouts/provider";
import { RateLimiter, RedisRateLimiter, makeRedis, waitReady } from "./api/ratelimit";

const config = loadConfig();
const prod = config.NODE_ENV === "production";
const db = new PgDb(config.DATABASE_URL);
// Production migrates out-of-band with owner credentials (`npm run migrate`); the runtime role cannot alter schema.
if (!prod) await migrate(db);
if (prod) await assertLeastPrivilege(db);
const adminDb = config.ADMIN_DATABASE_URL ? new PgDb(config.ADMIN_DATABASE_URL, 3) : undefined;
const provider = config.PAYOUT_PROVIDER === "stripe" ? new StripeConnectProvider(config.STRIPE_SECRET_KEY!, config.STRIPE_API_BASE) : new SimulatedProvider();
const redis = config.REDIS_URL ? makeRedis(config.REDIS_URL) : undefined;
if (redis) await waitReady(redis);
const limiter = redis ? (name: string, pm: number) => new RedisRateLimiter(redis, pm, `rl:${name}`) : (_n: string, pm: number) => new RateLimiter(pm);

const app = createApp(db, config, [webhookRoutes(), payoutRoutes(provider, adminDb)], { limiter });
const stopWorker = startWorker(db);
const payoutWorker = startPayoutWorker(db, provider);
app.server.listen(config.PORT, () => console.log(JSON.stringify({ level: "info", msg: "listening", port: config.PORT, simulation: config.simulation, payoutProvider: provider.name, sharedRateLimit: !!redis })));

const shutdown = () => { stopWorker(); payoutWorker.stop(); redis?.disconnect(); app.server.close(() => db.close().then(() => process.exit(0))); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
