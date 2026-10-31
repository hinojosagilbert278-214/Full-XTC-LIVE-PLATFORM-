import { loadConfig } from "./config";
import { PgDb, migrate } from "./db/pg";
import { createApp } from "./api/app";
import { webhookRoutes, startWorker } from "./webhooks/service";

const config = loadConfig();
const db = new PgDb(config.DATABASE_URL);
await migrate(db);
const app = createApp(db, config, [webhookRoutes()]);
const stopWorker = startWorker(db);
app.server.listen(config.PORT, () => console.log(JSON.stringify({ level: "info", msg: "listening", port: config.PORT, simulation: config.simulation })));

const shutdown = () => { stopWorker(); app.server.close(() => db.close().then(() => process.exit(0))); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
