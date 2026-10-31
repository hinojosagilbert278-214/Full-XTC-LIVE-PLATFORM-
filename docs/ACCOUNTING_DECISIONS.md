# Accounting decisions — for approval (Phase 5, Part 1)

**Status: PROPOSED. Nothing below is approved.** No existing ledger calculation has been changed.
Approval is recorded *in the system*: policy values live in `accounting_policy` (migration 005), seeded as
**unapproved**, and the payout engine and clawback logic refuse to run until an administrator approves each
required key through the admin-only approval function (audited, append-only history).
Recommended values below are proposals for finance/legal to accept or replace.

Sign convention: `earnings:*` balances are liabilities to creators (positive). `debt:*` accounts are platform
receivables (negative balance = amount owed to the platform). All amounts are integer coins.

---

## D1 — Platform remainder allocation
- **Existing:** `creator = floor(0.70·N)`, `family = floor(bps·creator/10000)` (taken from the creator share), `platform = N − floor(0.70·N)`; creator keeps `creator − family`. Always sums to N (tested for N<500).
- **Proposed default:** keep. Remainder (≤1 coin on the 70/30 split; family floor rounding stays with the creator).
- **Financial consequence:** platform gains <1 coin per gift versus an exact 30% (rounding favours the platform). The effect is largest on tiny gifts: a 1-coin gift gives the platform 1 and the creator 0; a 2-coin gift gives creator 1, platform 1 (50%).
- **Recommended decision:** keep the rule, **but** decide a minimum gift size or accept creators earn 0 on 1-coin gifts. Disclose in creator terms.
- **DB changes:** none (record approval in `accounting_policy` key `remainder_rule`).

## D2 — Creator payout after refunds
- **Existing:** approved gift refund reverses all four postings exactly once; if creator funds are gone the refund is parked `needs_review`.
- **Proposed default:** exact reversal always; unpaid funds come back from earnings; any shortfall becomes a clawback receivable (D3/D5), so the viewer refund is never blocked by creator payouts.
- **Consequence:** platform carries credit risk of creators who already withdrew; mitigated by D7 hold window.
- **Recommended:** approve the proposed default.
- **DB:** `creator_debt` account kind; `ledger_reverse_with_clawback` path (migration 005).

## D3 — Negative-balance policy
- **Existing:** no negatives except `coin_issuance`.
- **Proposed default:** user/creator/family *spendable* accounts still never negative. Shortfalls are recorded in dedicated `debt:<account>` accounts (asset, may be negative) — never as a negative earnings/wallet balance.
- **Consequence:** the ledger always shows who owes what; no hidden overdrafts; wallet/earnings CHECK constraint stays.
- **Recommended:** approve.
- **DB:** account kinds `creator_debt`, `user_debt`, `family_debt`; CHECK limiting `allow_negative` to approved kinds.

## D4 — Chargebacks (store/card disputes on coin purchases)
- **Existing:** same reversal as refunds; if coins were spent → `needs_review`.
- **Proposed default:** reverse what the wallet still holds; record the remainder in `debt:user:<id>`; **freeze** the wallet (no outgoing spends, DB-enforced) until debt is cleared or an admin releases; place chargeback holds (D7) on creators who received gifts from that user within the hold window, capped at the amounts received. Dispute fees are not modelled yet (need Stripe fee data).
- **Consequence:** stops further loss and prevents already-spent coins from being paid out; creators may see temporary holds.
- **Recommended:** approve; legal to confirm freezing is permitted under terms of service.
- **DB:** `ledger_accounts.frozen`, enforcement trigger, `payout_holds`.

## D5 — Creator clawbacks
- **Existing:** not implemented.
- **Proposed default:** debt is offset against new earnings automatically before they become payout-eligible (100% of newly matured earnings until cleared); no cash collection from creators; creators see the balance; debts older than 12 months go to admin review for write-off (write-off is a separate, audited entry).
- **Consequence:** payout availability is reduced by outstanding debt.
- **Recommended:** approve; the 12-month rule is optional.
- **DB:** `debt:*` accounts, offset entry type `debt_offset`.

## D6 — Family revenue reversals
- **Existing:** family share reversed with the entry.
- **Proposed default:** same, with shortfall recorded in `debt:family:<id>` and offset against future family earnings. Family leaders are not personally liable.
- **Consequence:** a family that already distributed funds off-platform cannot be pursued; platform absorbs.
- **Recommended:** approve.
- **DB:** `family_debt` kind.

## D7 — Payout holds
- **Existing:** none.
- **Proposed default:** (a) maturity window: creator-share earnings become available **7 days** after the gift; (b) holds block payouts: refund-related (auto on refund request, amount = creator share of the entry), chargeback-related (auto, D4), administrative and risk (manual); (c) first payout and payouts ≥ a review threshold require admin approval.
- **Consequence:** creators wait ≥7 days; reduces clawback exposure. Longer windows lower risk but hurt creator experience.
- **Recommended:** 7 days, review threshold set by finance (**no default proposed**).
- **DB:** `accounting_policy` keys `hold_days`, `review_threshold_coins`; `payout_holds` table.

## D8 — Available vs pending earnings
- **Existing:** API shows one total balance; `pendingAvailableSplit: "undecided"`.
- **Proposed default:** `pending` = creator-share postings younger than `hold_days`; `available = max(0, balance − pending − active holds − debt)`; payouts only from available. Computed from immutable postings (no mutable pending counters). Conservative: overlapping pending and hold amounts are both subtracted.
- **Consequence:** creators may see lower available than strictly necessary when a hold covers recent gifts.
- **Recommended:** approve.
- **DB:** none beyond D7 (computed view/function `creator_availability`).

---

## Additional rules the payout engine needs (not in the original eight)
| Key | Meaning | Proposed |
|---|---|---|
| `coin_value_usd_micros` | USD value of 1 coin ×10⁶ | **none — business must supply** |
| `min_payout_coins` | minimum payout | finance to set |
| `payout_currency` | settlement currency | `usd` |
| `max_payout_attempts` | provider retries before admin review | 5 |

These, plus D1–D8, are `accounting_policy` keys; **payouts cannot be requested until `hold_days`, `coin_value_usd_micros`, `min_payout_coins`, `review_threshold_coins` and `clawback_mode` are approved.**
Compliance items (KYC/tax forms, money-transmission analysis) still require legal review and are outside this document.
