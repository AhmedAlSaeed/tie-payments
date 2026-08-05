# T02 — Gateway landscape: which drivers for v1

```yaml
id: research-gateways
parent: map-001
type: research
status: closed
resolved: 2026-08-05
```

## Question

Which payment gateways should the v1 driver set cover, and what does the real API surface of each candidate look like — so the unified abstraction (Pillar 1) and the mock-gateway matrix (section 4.3 of SPEC.md) can be designed against facts, not assumptions?

## What we need to know

- For each candidate (BENEFIT/BenefitPay, Jaywan, Tap, Moyasar, HyperPay, PayTabs, Stripe, Checkout.com, Adyen): sandbox availability, auth model, charge/tokenize/refund endpoints, webhook formats, 3DS support, and whether it realistically fits a v1 GCC-focused launch.
- How diverse the payloads actually are — where the abstraction seams should be.
- Mock-gateway realism: which of the SPEC.md test scenarios (4242 success, 0002 insufficient, 9999 timeout, 3D01 3DS, BenefitPay QR Fawri+) map to real gateway behaviors.

Resolved by a research subagent. Findings recorded here; a comparison table linked as an asset.

## Resolution

Research complete. Asset: `.scratch/wayfinder/research/T02-gateway-landscape.md`.

Key findings:
- **Recommended v1 driver set**: Mock Gateway (default, sandbox), **Tap** (primary — native BenefitPay `src_bh.benefit`, Benefit cards, BHD), **Stripe** (global cards, best sandbox/webhook tooling), **Moyasar** (KSA mada/STC Pay, cleanest client-side tokenization). Stretch: **Checkout.com** (direct BenefitPay QR + Benefit PG + BHD). Defer: PayTabs, HyperPay, Adyen.
- **Not drivers**: **Jaywan** (UAE card scheme / BIN range, not a PSP — no API/sandbox; model as a BIN routing rule), **direct BENEFIT** (Fawri+ is ISO 20022 rail, no merchant-facing API — reached via Tap/Checkout.com).
- **Abstraction seams**: ① `createPayment → action` (`{status, action: redirect|qr|client_secret|hosted_page}` — ~80% of driver code); ② `tokenize` (client-side, publishable-key, hosted-fields; raw PAN disabled by default → SAQ A); ③ `authorize/capture/refund/void` (sale-vs-auth split, refund shape); ④ `webhook → event` (per-driver verify — raw-body HMAC vs in-payload HMAC vs unsigned+refetch; keep raw body).
- **Currency exponent gotcha**: BHD = 3 decimals (fils) vs 2-decimal AED/SAR — abstraction must carry a currency exponent, never hardcode ×100.
- **Mock matrix mapping**: 4242/3D01 + BenefitPay QR map cleanly to Stripe/Checkout.com test cards; "0002" is a generic decline (real insufficient = Stripe 9995/code 51); "9999" is a gateway timeout, not a card.
