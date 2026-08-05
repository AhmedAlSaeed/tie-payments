# T05 — Invoice engine state machine & VAT

```yaml
id: invoice-engine
parent: map-001
type: prototype
status: open
blocked-by: [research-surrealdb]
```

## Question

What is the exact invoice engine design (Pillar 2): the enforced lifecycle state machine (draft → issued → partially_paid → paid → voided / overdue), line-item/tax/discount/multi-currency rules, Bahrain 5% VAT + TIN itemization, and the HPP/payment-link flow that drives state transitions?

## Deliverables

- Invoice state machine: states, legal transitions, who can trigger each, what events they emit.
- Line-item model: unit amounts, quantity, VAT 5% + VAT-inclusive/exclusive handling, percentage/flat discounts, currency conversion.
- HPP + payment-link flow: session creation, hosted page lifecycle, how payment outcome moves the invoice state.
- Draft SurrealDB schema for invoices (aligned with T01).
