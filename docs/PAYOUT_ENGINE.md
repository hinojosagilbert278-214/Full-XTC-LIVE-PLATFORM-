# Payout engine — design and schema (Phase 5)

Layering (collection and payout are independent; the ledger is the only shared truth):

```
Apple · Google · Stripe · RevenueCat ──webhooks──▶ ledger (purchase / refund / chargeback)
                                                     │
                 Creator earnings (earnings:<u>) ◀── gifts (70/30, family share)
                                                     │  availability = balance − pending − holds − debt
                                          Payout orchestrator (src/payouts/service.ts)
                                                     │  reserve → settle / return / reverse (ledger entries)
                                       PayoutProvider  ──▶ SimulatedProvider | StripeConnectProvider
```

## Money buckets (all derived, none stored as mutable counters)
| Bucket | Source |
|---|---|
| balance | `earnings:<u>` cached balance (trigger-maintained, CHECK ≥ 0) |
| pending | `creator_share` postings younger than `hold_days` (net of reversals) |
| held | active rows in `payout_holds` (refund, chargeback, admin, risk) |
| debt | −balance of `debt:creator:<u>` (platform receivable from clawbacks) |
| available | max(0, balance − pending − held − debt) |
| reserved | payouts in pending_review/queued/processing/needs_review (money sits in `payout:clearing`) |
| paid | `payout:paid` |

## State machine (enforced by trigger `payouts_guard`, even against the table owner)
```
pending_review ─approve→ queued ─claim→ processing ─ok→ paid ─provider reversal→ reversed
      │reject/cancel        │cancel          │ │ └reject→ failed (funds returned)
      ▼                     ▼                │ └uncertain→ processing (lease) ─lookup/retry…
   cancelled             cancelled           └attempts exhausted / account ineligible→ needs_review
needs_review ─admin: retry→queued | fail→failed | mark_paid→paid (needs provider proof) | cancel→cancelled
```
Terminal: failed, cancelled, reversed. `payout_events` (append-only) records every transition with actor.
Amount, user, account and idempotency key are immutable; `provider_ref` is immutable once set and unique per provider.

## Ledger flow (keys make every step idempotent)
reserve `payout:{id}:reserve` earnings→clearing · settle `:settle` clearing→paid · return `:return` clearing→earnings ·
reverse `:reverse` paid→earnings · debt offset `debt_offset:{user}:{key}` earnings→debt. Corrections are always new entries.

## Safety properties
- **Never pay twice:** unique `(user, idempotency_key)`; provider idempotency key `payout-{id}`; `provider_ref` unique; `markPaid` is a guarded transition (second caller no-ops); workers claim with `FOR UPDATE SKIP LOCKED` + lease.
- **Timeout ≠ failure:** `ProviderUnknown` never returns funds; payout stays `processing`, and after lease expiry the worker *looks up* the transfer (`transfer_group=payout-{id}`) before creating again.
- **Provider "paid" = transfer created.** Bank settlement is not tracked here and is not guaranteed.
- **No silent debt erasure:** shortfalls from refunds are booked to `debt:*` in the same balanced entry (`reverseWithClawback`); offsets are explicit entries.
- **Policy gate:** requests fail (app *and* DB trigger) until `hold_days, coin_value_usd_micros, min_payout_coins, review_threshold_coins, clawback_mode` are approved via `approve_policy()` (xtc_admin only, history append-only).
- First payout and payouts ≥ `review_threshold_coins` need admin review. Refund requests auto-hold the creator share (DB trigger).

## Known limitations
- Chargeback → automatic holds on downstream creators is **not** automated (admin creates `chargeback` holds; wallet freeze is an admin action). Dispute fees are not modelled.
- `transfer.reversed` / `account.updated` Connect webhooks are **not** wired; reversal and profile sync are admin/user-triggered (`/v1/admin/payouts/:id/reverse`, `/v1/payouts/profile/sync`) and reconciliation detects provider-side reversals.
- Family-share holds are not created (only creator share). Payout currency fixed to USD.
- A creator can re-link a different Stripe account; this resets verification but has no cooling-off period (account-takeover risk, see SECURITY.md).
