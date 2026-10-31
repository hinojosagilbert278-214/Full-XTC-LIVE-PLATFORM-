import type { AddressInfo } from "node:net";
import { createApp, type App } from "../../src/api/app";
import { loadConfig, type Config } from "../../src/config";
import { signJwt } from "../../src/api/auth";
import { freshDb, TEST_URL } from "./helper";

export const SECRET = "test-secret-test-secret-test-secret-123";
export const baseEnv = { NODE_ENV: "test", DATABASE_URL: TEST_URL, JWT_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: "100000", WEBHOOK_SIMULATION: "false" };

export async function startApp(env: Record<string, string> = {}, extra: Array<(a: App) => void> = []) {
  const db = await freshDb();
  const config: Config = loadConfig({ ...baseEnv, ...env });
  const app = createApp(db, config, extra);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, db, url, close: async () => { await new Promise((r) => app.server.close(r)); await db.close(); } };
}

export const token = (sub: string, role = "user", over: object = {}) =>
  signJwt({ sub, role, iss: "xtc-identity", aud: "xtc-wallet", exp: Math.floor(Date.now() / 1000) + 600, ...over }, SECRET);

export async function call(url: string, method: string, path: string, o: { tok?: string; body?: unknown; key?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.tok) headers.authorization = `Bearer ${o.tok}`;
  if (o.key) headers["idempotency-key"] = o.key;
  if (o.body !== undefined || o.raw !== undefined) headers["content-type"] ??= "application/json";
  const r = await fetch(url + path, { method, headers, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined) });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
