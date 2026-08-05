# Adopt Stripe's invoice lifecycle over SPEC's status sketch

The invoice engine mirrors Stripe's Invoicing model rather than the SPEC's
simplified `draft → issued → partially_paid → paid → voided / overdue` line.
Stored statuses are `draft | open | paid | voided | uncollectible`; `overdue`
and `partial` are derived (not stored), and overpayment lands on a customer
credit balance. SPEC is a seed, not a contract, and Stripe's model is the
battle-tested shape the market expects from a billing engine — so the states,
amounts (`amount_due/paid/remaining/overpaid`), finalization and
`collection_method` all follow Stripe. A future engineer reading the schema
will find `open` and wonder where `issued` went; this is the why.
