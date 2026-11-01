import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StripeConnectProvider, ProviderRejected, ProviderUnknown } from "../src/payouts/provider";

// A local FAKE of the Stripe API surface we use. This proves our request/response handling only; it is NOT Stripe verification.
let mode = "ok"; const seen: any[] = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers["idempotency-key"], body });
    const send = (s: number, o: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
    if (mode === "500") return send(500, { error: {} });
    if (mode === "429") return send(429, { error: {} });
    if (mode === "400") return send(400, { error: { code: "balance_insufficient" } });
    if (mode === "garbage") return send(200, "not json");
    if (mode === "hang") return;
    if (req.method === "POST" && req.url === "/v1/transfers") return send(200, { id: "tr_1", amount: 300 });
    if (req.url!.startsWith("/v1/transfers?")) return send(200, { data: mode === "found" ? [{ id: "tr_1", amount: 300, reversed: false }] : [] });
    if (req.url === "/v1/accounts/acct_ok") return send(200, { details_submitted: true, payouts_enabled: true, requirements: {} });
    if (req.url === "/v1/accounts/acct_restricted") return send(200, { details_submitted: true, payouts_enabled: false, requirements: { disabled_reason: "requirements.past_due" } });
    send(404, { error: { code: "resource_missing" } });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => { server.close(); });
const p = new StripeConnectProvider("sk_test_fake", url, 300);
const req = { payoutId: 7, accountId: "acct_ok", amountMinor: 300n, currency: "usd", idempotencyKey: "payout-7" };

describe("StripeConnectProvider against a local fake", () => {
  it("sends idempotency key, transfer_group and bearer auth", async () => {
    mode = "ok"; seen.length = 0;
    expect(await p.createTransfer(req)).toEqual({ ref: "tr_1" });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/transfers", auth: "Bearer sk_test_fake", idem: "payout-7" });
    const f = new URLSearchParams(seen[0].body);
    expect([f.get("amount"), f.get("currency"), f.get("destination"), f.get("transfer_group")]).toEqual(["300", "usd", "acct_ok", "payout-7"]);
  });
  it("classifies outcomes: 4xx rejected; 5xx/429/garbage/timeout unknown (never a definitive failure)", async () => {
    mode = "400"; await expect(p.createTransfer(req)).rejects.toThrow(ProviderRejected);
    for (const m of ["500", "429", "garbage", "hang"]) { mode = m; await expect(p.createTransfer(req)).rejects.toThrow(ProviderUnknown); }
    const dead = new StripeConnectProvider("k", "http://127.0.0.1:1", 300);
    await expect(dead.createTransfer(req)).rejects.toThrow(ProviderUnknown);
  });
  it("looks up by transfer_group and reads account state", async () => {
    mode = "found"; expect(await p.findTransfer(7)).toEqual({ ref: "tr_1", amountMinor: 300n, reversed: false });
    mode = "ok"; expect(await p.findTransfer(7)).toBeNull();
    expect(await p.getAccount("acct_ok")).toEqual({ exists: true, verified: true, payoutsEnabled: true });
    expect(await p.getAccount("acct_restricted")).toMatchObject({ verified: false, payoutsEnabled: false });
    expect(await p.getAccount("acct_missing")).toMatchObject({ exists: false });
  });
});
