# T08 — Sandbox, mock gateway & testing environment

```yaml
id: sandbox
parent: map-001
type: prototype
status: open
blocked-by: [gateway-abstraction]
```

## Question

What is the sandbox/testing environment design (section 4 of SPEC.md): dual-environment data partitioning (test/live API keys, `environment` enum, zero-leak isolation), the under-60-seconds onboarding flow, and the mock gateway driver with the full test-card matrix including the BenefitPay QR "Simulate Scan & Pay"?

## Deliverables

- Env partitioning mechanics: key generation, `environment` enum enforcement in every query, isolation guarantees.
- Onboarding flow: signup → auto-generate sk_test → pre-activated mock driver → 1-line SDK snippet → simulated payments + admin log stream reveal.
- Mock gateway driver: implements the T03 abstraction, produces the SPEC section 4.3 matrix (4242/0002/9999/3D01/BenefitPay QR), drives webhook emission for the admin streamer.
- Draft schema (aligned with T01).