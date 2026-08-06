# 05 — T2: Invoice collection & payment outcome

**What to build:** Money moves on an invoice. `charge_automatically` charges via routed gateway; outcome moves amount_paid → paid. `send_invoice` via hosted_invoice_url. Overpay → credit_balance → next invoice. `void` / `mark_uncollectible`.

**Blocked by:** 02 (T1 — finalize).

**Status:** ready-for-ticket

- [ ] collection_method honored (charge_automatically → driver payment; send_invoice → hosted_invoice_url).
- [ ] Success → amount_paid; `paid` when == amount_due; overpaid → credit_balance.
- [ ] `void` + `mark_uncollectible` from open with timestamps + events.
- [ ] Emits invoice.paid / payment_failed / payment_action_required / voided / marked_uncollectible → outbox.
- [ ] Credit balance applies to next invoice's amount_due.
- [ ] Mock matrix tests (4242 paid / 0002 failed / 3D01 action-required); typecheck + lint clean.

GitHub: #17
