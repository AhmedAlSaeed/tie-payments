# 08 — T7: Sandbox onboarding + mock flows (T08)

**What to build:** Under-60-second onboarding. Better Auth signup auto-provisions merchant + sk_test/pk_test (hash-stored) + default mock RoutingRule + 1-line snippet. Simulated payments drive the real pipeline (events reach streamer). 3D01 → guarded mock 3DS challenge page. QR → "Simulate Scan & Pay".

**Blocked by:** 01 (F0), 04 (T5 — webhook engine).

**Status:** ready-for-ticket

- [ ] Signup auto-provisions merchant + test keys (hash-only) + mock RoutingRule; snippet returned.
- [ ] context.ts binds merchantId/env from key record.
- [ ] Sandbox test-pay routes through real inbound webhook → canonical pipeline (visible in GET /v1/event_deliveries).
- [ ] Guarded `/mock/3ds` challenge completes requires_action via real pipeline.
- [ ] Mock QR `qr_...` returns scannable outcome.
- [ ] Tests (onboarding + streamer visibility); typecheck + lint clean.

GitHub: #22
