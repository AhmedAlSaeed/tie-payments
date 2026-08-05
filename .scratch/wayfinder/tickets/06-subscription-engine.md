# T06 — Subscription & recurring billing engine

```yaml
id: subscription-engine
parent: map-001
type: grilling
status: open
blocked-by: [invoice-engine]
```

## Question

What is the subscription engine design (Pillar 3): schedule modeling (daily/weekly/monthly/annual/custom cron), pricing models (flat, seat-based, usage/metered, tiered), and the smart-dunning retry flow before cancellation?

## Deliverables

- Subscription schedule model and recurrence calculation.
- Pricing model representation for each of the four types — including how usage/metered events are reported and billed.
- Dunning: retry schedules, failure escalation, cancellation triggers, integration with the invoice engine and webhook engine.
- Draft SurrealDB schema (aligned with T01).
