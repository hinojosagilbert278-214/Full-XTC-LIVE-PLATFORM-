# Accounting rules — status and decisions required

The brief requires confirmation of existing business rules **before** changing economic calculations.
No existing rule source exists in this repo, so **no calculation was changed** in Phase 4. Current
behaviour is listed with the safest proposed default. **Each row needs owner sign-off (finance + legal).**

| # | Topic | Current behaviour (implemented) | Proposed default | Status |
|---|---|---|---|---|
| 1 | Platform remainder | `platform = coins − floor(0.70·coins)`; family = floor(bps·creator/10000); creator gets the rest of the creator share | Keep (remainder to platform, deterministic, always sums) | **Needs confirmation** |
| 2 | Creator payout after refunds | Reversal reverses creator/family/platform postings exactly, once | Keep exact reversal | Needs confirmation |
| 3 | Negative balances | Forbidden everywhere except `coin_issuance` contra account. Reversal that would overdraw → `needs_review`, no ledger change | Add explicit `clawback_receivable` account (asset, may be negative) so a debt to the platform is recorded instead of blocking | **Decision required** |
| 4 | Chargebacks | Same reversal path as refunds; unspendable coins → `needs_review` | Freeze wallet + open clawback receivable; fee line for dispute fees | **Decision required** |
| 5 | Creator clawbacks | Not implemented (blocked on #3) | Offset against future earnings, with cap and notice | Decision required |
| 6 | Family revenue reversals | Family share reversed with the entry | Keep | Needs confirmation |
| 7 | Payout holds | Not implemented | Hold window (e.g. N days, risk-based) before earnings become available | Decision required |
| 8 | Available vs pending | API returns total `balance`; `pendingAvailableSplit: "undecided"` | Pending → available after hold window; payouts only from available | Decision required (depends on #7) |

Corrections policy (implemented): the ledger is append-only (DB triggers). Corrections are new
reversing entries referencing `reverses_entry` (unique ⇒ at most one reversal per entry). Cached
balances are verified against postings by `ledger_discrepancies`.
