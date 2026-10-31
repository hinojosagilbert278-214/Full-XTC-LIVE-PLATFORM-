import { PgDb, migrate } from "./db/pg";
// Run with owner credentials (never the runtime role): npm run migrate
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
const db = new PgDb(url, 2);
await migrate(db);
await db.close();
console.log(JSON.stringify({ level: "info", msg: "migrations applied" }));
