/** Provider boundary for creator payouts. "Paid" means the provider accepted a transfer; bank settlement is NOT tracked here. */
export class ProviderRejected extends Error {}   // definitive: the provider did not and will not create the transfer
export class ProviderUnknown extends Error {}    // outcome uncertain (timeout, 5xx, network): never treat as failure

export interface TransferRequest { payoutId: number; accountId: string; amountMinor: bigint; currency: string; idempotencyKey: string }
export interface TransferInfo { ref: string; amountMinor: bigint; reversed: boolean }
export interface AccountInfo { exists: boolean; verified: boolean; payoutsEnabled: boolean }

export interface PayoutProvider {
  readonly name: string;
  createTransfer(r: TransferRequest): Promise<{ ref: string }>;
  /** Look up by our payout id (transfer_group) to recover from uncertain outcomes. */
  findTransfer(payoutId: number): Promise<TransferInfo | null>;
  getAccount(accountId: string): Promise<AccountInfo>;
}

type Fault = "reject" | "unknown_before" | "unknown_after";

/** Deterministic in-memory provider for tests and simulation mode. Not a model of Stripe's real behaviour. */
export class SimulatedProvider implements PayoutProvider {
  readonly name = "simulation";
  readonly transfers = new Map<string, TransferInfo & { payoutId: number }>(); // by idempotency key
  calls = 0;
  accounts = new Map<string, AccountInfo>();
  private faults: Fault[] = [];
  failNext(...f: Fault[]) { this.faults.push(...f); }
  async createTransfer(r: TransferRequest) {
    this.calls++;
    const existing = this.transfers.get(r.idempotencyKey);
    const fault = this.faults.shift();
    if (fault === "reject") throw new ProviderRejected("simulated rejection");
    if (fault === "unknown_before") throw new ProviderUnknown("simulated timeout before reaching provider");
    const t = existing ?? { ref: `sim_tr_${this.transfers.size + 1}`, amountMinor: r.amountMinor, reversed: false, payoutId: r.payoutId };
    this.transfers.set(r.idempotencyKey, t);
    if (fault === "unknown_after") throw new ProviderUnknown("simulated timeout after provider succeeded");
    return { ref: t.ref };
  }
  async findTransfer(payoutId: number) {
    for (const t of this.transfers.values()) if (t.payoutId === payoutId) return t;
    return null;
  }
  async getAccount(id: string) { return this.accounts.get(id) ?? { exists: true, verified: true, payoutsEnabled: true }; }
  reverse(payoutId: number) { const t = [...this.transfers.values()].find((x) => x.payoutId === payoutId); if (t) t.reversed = true; }
}

/** Stripe Connect (Express) transfers. Exercised ONLY against a local fake HTTP server; never verified against Stripe. */
export class StripeConnectProvider implements PayoutProvider {
  readonly name = "stripe";
  constructor(private secretKey: string, private baseUrl = "https://api.stripe.com", private timeoutMs = 10_000) {}
  private async call(method: string, path: string, body?: URLSearchParams, idem?: string) {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method, body, signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.secretKey}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(idem ? { "Idempotency-Key": idem } : {}) },
      });
    } catch (e) { throw new ProviderUnknown(`network: ${(e as Error).message}`); }
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = null; }
    if (res.status >= 500 || res.status === 429 || res.status === 409 || json === null) throw new ProviderUnknown(`http ${res.status}`);
    if (res.status >= 400) {
      if (res.status === 404 && method === "GET") return { status: 404, json };
      throw new ProviderRejected(`http ${res.status}: ${json?.error?.code ?? "error"}`);
    }
    return { status: res.status, json };
  }
  async createTransfer(r: TransferRequest) {
    const b = new URLSearchParams({ amount: r.amountMinor.toString(), currency: r.currency, destination: r.accountId, transfer_group: `payout-${r.payoutId}`, "metadata[payout_id]": String(r.payoutId) });
    const { json } = await this.call("POST", "/v1/transfers", b, r.idempotencyKey);
    if (typeof json?.id !== "string") throw new ProviderUnknown("malformed response");
    return { ref: json.id as string };
  }
  async findTransfer(payoutId: number) {
    const { json } = await this.call("GET", `/v1/transfers?transfer_group=${encodeURIComponent(`payout-${payoutId}`)}&limit=1`);
    const t = json?.data?.[0];
    return t ? { ref: t.id as string, amountMinor: BigInt(t.amount), reversed: !!t.reversed } : null;
  }
  async getAccount(id: string) {
    const { status, json } = await this.call("GET", `/v1/accounts/${encodeURIComponent(id)}`);
    if (status === 404) return { exists: false, verified: false, payoutsEnabled: false };
    return { exists: true, verified: !!json.details_submitted && !json.requirements?.disabled_reason, payoutsEnabled: !!json.payouts_enabled };
  }
}
