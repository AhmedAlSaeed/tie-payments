# T02 — Gateway landscape: which drivers for v1

> Research asset for ticket `research-gateways` (map-001). Facts verified against vendor docs Feb–Aug 2026; primary URLs in [Sources](#sources). Do not rely on training data for endpoint/auth facts — these are current.

**Bottom line up front**
- **Recommended v1 driver set (Bahrain-first):** **Tap** (primary — covers BenefitPay, Benefit cards, BHD, cards, KNET-adjacent GCC), **Stripe** (global cards/AED/SAR for non-Bahrain growth + best-in-class test tooling), **Moyasar** (KSA cards/mada/STC Pay, lowest onboarding friction of the KSA set), and the **built-in Mock Gateway** (default in sandbox). **Optional stretch:** Checkout.com (direct BenefitPay QR + Benefit PG + BHD, strongest Bahrain local-rail story behind Tap), Adyen (enterprise, if a UAE/KSA acquirer is secured).
- **Defer:** PayTabs (legacy-style HPP/IPN, non-REST), HyperPay (OPPWA is payment-widget-centric with IP-whitelisted server API; strong Saudi mada but not Bahrain-first), **Jaywan** (it is a **UAE** national card scheme / BIN range, not a gateway — no public developer API or sandbox; acquire it through a UAE-capable acquirer/gateway, not a driver), **direct BENEFIT** (Fawri+ push is an ISO 20022 bank-integration domain, no merchant-facing public API/sandbox).
- **The abstraction must NOT copy any one vendor.** Payloads differ meaningfully in: auth model, amount/currency representation (BHD=3 decimal places!), payment-source model (token vs `src_` constant vs raw card), redirect/action semantics, and webhook signing (raw-body HMAC vs in-payload HMAC vs unsigned+re-fetch).

---

## Comparison matrix

| Candidate | Sandbox / credentials | Auth model | Core endpoints | Tokenization (PCI SAQ A) | Webhooks | 3-D Secure | GCC fit & v1 |
|---|---|---|---|---|---|---|---|
| **BENEFIT / BenefitPay** (BH, direct) | **No public self-serve sandbox.** BenefitPay Business Account is in-app (bank-approval KYC via CR). Merchant API access is via **supported acquirers** (Benefit PG), or via gateways (Tap `src_bh.benefit`, Checkout.com `source.type=benefitpay`). Simulator app exists for QR testing (gateway-managed). | Acquirer/agreement based; no public REST auth scheme. Fawri/Fawri+ is ISO 20022 rail. | No public charge/token endpoints. QR-initiated instant payment; Fawri+ push credit (24/7, ~30s, BHD 3,000/day). | n/a (wallet QR, no PAN). | Merchant gets push/alerts; gateway webhooks (`payment_captured` etc.) are the integration surface. | n/a | **Essential for Bahrain launch but not as a direct driver.** Reached via Tap/Checkout.com. No native refunds — refund = bank transfer. |
| **Jaywan** (UAE) | None public. It is the **CBUAE/Al Etihad Payments national debit scheme** (launched via banks; BIN 66900900–66901099). Enablement via UAE acquirers (e.g. N-Genius) or gateways that accept the BIN. | No merchant API; it's a card **scheme**, not a PSP. | Accept as a normal card over the acquiring rail; settlement in AED. | Standard card tokenization via the gateway/acquirer. | Via the acquirer/gateway. | **3DS 2.2 mandatory** for e-com (CBUAE mandate). | **Not a v1 driver.** Wrong market (UAE, not Bahrain) and no sandbox. Model as a "network/BIN routing rule", not a driver. |
| **Tap** (BH/UAE/KW) | **Free sandbox on signup**; `sk_test_`/`pk_test_` issued immediately in dashboard. | `Authorization: Bearer sk_test_…` (also `pk_` for card SDK). | `POST /v2/charges`, `POST /v2/authorize`, `GET /v2/charges/{id}`, `POST /v2/charges/{id}/refunds`; `POST /v2/tokens` (card/saved-card). | Yes. Card Web SDK (V1/V2) for client-side tokens — no PCI cert needed. `POST /v2/tokens` server-side requires PCI cert. Supports `save_card` → `cus_`/`card_`. | `post.url` in request; delivery includes `hashstring`/`hash` headers = HMAC-SHA256 over selected fields; verify against stored values. Webhook example is full charge object (status, activities[]). | `threeDSecure: true` → charge returns `transaction.url` to redirect for challenge; status INITIATED→captured via webhook/retrieve. Supports external `authentication` object (ECI/token). | **Best Bahrain-first single driver**: native BenefitPay (`src_bh.benefit`), Benefit cards, BHD; also mada/AED/SAR. **v1: YES (primary).** |
| **Moyasar** (KSA) | Free sandbox; `pk_test_`/`sk_test_` in dashboard. Live keys need account activation. | **HTTP Basic** auth, username=`sk_test_…`, password empty. `pk_` restricted to `POST /v1/payments` + `/v1/tokens`. | `POST /v1/payments` (initiated→`source.transaction_url`), `GET /v1/payments/{id}`, `POST /v1/payments/{id}/refund`; `POST /v1/tokens`. | Yes. **Client-side tokenization** with `pk_test_` from the payment form (tokenization feature enable). Raw PAN to server prohibited. | callback_url for redirect-return; async payment messages to webhook URL (docs list webhook payloads); verify via payment status. | 3DS on by default (`source["3ds"]: true`); payment returns `initiated` + `transaction_url` challenge URL. `3ds:false` = MOTO (needs enablement). Standalone auth + bring-your-own 3DS for selected merchants. | KSA-native: mada, STC Pay, Apple/Samsung Pay, SAR/AED. Cleanest docs of the KSA set. **v1: YES** (secondary — KSA cards/mada via clean client-side tokenization). |
| **HyperPay** (Arabia, OPPWA-based) | Sandbox at `test.oppwa.com`; access token + per-brand **Entity IDs** issued on sandbox account creation. Live requires SAMA-licensed merchant approval. | `Authorization: Bearer {access_token}` + `entityId` per brand (Visa/MC, **mada**, AMEX). Server API also supports HMAC/custom `api-key`+`signature`+`timestamp` header scheme (SHA256WithRSA, IP-whitelisting). | `POST /v1/checkouts` → `checkoutId` + `resourcePath`; `GET /v1/checkouts/{id}/payment`; refund `POST /v1/payments/{id}` with `paymentType=RF`. | Yes. **COPYandPAY JS widget** — card data goes browser→OPPWA, merchant never sees PAN (SAQ A path). | Notification URL in dashboard; **not HMAC-signed** in the widget flow — docs recommend re-fetching `/v1/checkouts/{id}/payment` for truth. HMAC-secret verification exists on some modules. | Handled inside COPYandPAY widget (challenge presented inline); result codes e.g. `100.390.103` 3DS auth failed, `800.100.152` declined by auth. | Saudi mada specialist, enterprise-scale. Widget/redirect-centric, weaker headless/BHD. **v1: optional/defer** (KSA via Moyasar is easier). |
| **PayTabs** (MENA) | Test profile + **test terminal** auto-created; test cards listed in dashboard (4000000000000002 = 3DS-enrolled Visa, 4111… = no 3DS). | `profile_id` + `server_key` per region endpoint (AE/SA/EG/etc.); client tokenization uses `client_key`. | `POST {domain}/payment/request` (HPP), `POST /payment/query` (status); transaction `tran_type` sale/auth + `tran_class`; refunds via transaction API. | Via **Hosted Payment Page** or own-form with `client_key` (`tokenise`/`show_save_card`). Card never hits merchant when using HPP. | **IPN callback** = server-to-server POST to configured URL with full transaction; verify with signature (server key). Return URL is browser-redirect (not reliable — IPN is). | 3DS simulated by test terminal; redirect flow; `tran_status` in IPN. | Widely used in GCC, but API is HPP/IPN-era (form-POST, string amounts), not modern REST. **v1: defer** (no headless intent model; Tap/Stripe cover the need). |
| **Stripe** | **Instant free test mode**, no approval; `sk_test_`/`pk_test_`; Stripe CLI (`stripe listen --forward-to`). Feature-complete test env + canonical test cards. | Bearer/secret `sk_test_`; publishable `pk_test_` for Elements. Idempotency-Key header. | `POST /v1/payment_intents` (→ `client_secret`), `POST /v1/confirm`, `POST /v1/payment_intents/{id}/capture`, `POST /v1/refunds`; `POST /v1/tokens`, `POST /v1/payment_methods`. | Yes. **Payment Element/Elements** client-side tokenization → PaymentMethod; raw PAN never on merchant server (SAQ A). | **`Stripe-Signature` header, HMAC-SHA256 over RAW body** (must verify un-deserialized bytes); event types `payment_intent.succeeded/failed`, `charge.refunded`, etc.; replay-safe (idempotency by event.id). | `request_three_d_secure: automatic/any/required`; SCA Engine; test card 4000 0027 6000 3184 forces challenge; result surfaces via status/`next_action.redirect_to_url`. | No native BHD; strong AED/SAR via UAE/KSA entities; **no native BenefitPay**. Global-card default. **v1: YES** (global cards + best sandbox/webhook tooling). |
| **Checkout.com** | Free sandbox account; `sk_test_`; live needs onboarding/approval (SAMA licence covers KSA). BenefitPay/Benefit PG need CSM activation in sandbox. | `Authorization: {sk_test_…}` (secret key in header; documented). | `POST /payments` (source.type: card/token/benefitpay), `POST /tokens`, `POST /payment-sessions` (+Flow client SDK), `GET /payments/{id}`, `POST /payments/{id}/refunds`, `POST /payments/{id}/voids`, capture via `POST /payments/{id}/captures`. | Yes. **Payment Sessions + Flow Web Components** `cardComponent.tokenize()` → single-use token (PCI SAQ A). | **`Cko-Signature` header = HMAC-SHA256 (secret key) over raw body**; events `payment_approved/declined/captured/refunded`; also `payment_pending`, `payment_capture_pending`, `payment_captured` for BenefitPay. | `3ds.enabled:true` + `attempt_n3d` downgrade; full 3DS up to 2.2.0; **Sessions API** for standalone hosted/non-hosted auth (EMV 3DS). | **Direct Bahrain local rails**: BenefitPay QR (`source.qr_data` → scan → `payment_captured`) and Benefit PG (BHD, via acquirer registration), plus BHD/AED/SAR. **v1: strong secondary** if you want local-rail depth beyond Tap. |
| **Adyen** | Free **test Customer Area** (test company) — full sandbox; API keys + HMAC keys per webhook. Live requires onboarding + acquiring relationship (MENA via UAE/KSA partner acquirers). | `X-API-Key: {api key}` header (Checkout API); HMAC keys for webhooks. `Idempotency-Key` header. | `POST /v68/payments` (resultCode + `action`), `POST /v68/payments/details`, `POST /v68/payments/{ref}/captures`, `POST /v68/payments/{ref}/refunds`, `POST /v68/payments/{ref}/cancels`, `POST /v68/payments/{ref}/reversals`; `POST /v68/tokens`. | Yes. **Secured Fields SDK** (Adyen Components) — PAN to Adyen, not merchant. | **HMAC in `additionalData.hmacSignature`** for payment webhooks (signed subset of fields, ordered), or header `hmacSignature` for others; `eventCode` AUTHORISATION/CAPTURE/REFUND/PAYMENT_FAILED + `success` bool. | 3DS2 first-class: resultCode `ChallengeShopper`/`RedirectShopper`/`IdentifyShopper` → `action` → submit via `/payments/details` (`threeDSResult`). | Enterprise-grade, global; **BHD possible via GCC acquirer but onboarding heavy**; BenefitPay not native. **v1: defer** (overkill for launch; keep as later driver). |

---

## Abstraction seams

Payload diversity is real but **bounded**. Four-plus-one seams cover it:

### 1. `createPayment` / session → normalized **action**
Every gateway returns an intermediate state + a way for the UI to finish:
- Tap: charge `status: INITIATED` + `transaction.url`
- Moyasar: payment `initiated` + `source.transaction_url`
- Checkout.com: 202 `Pending` + `source.qr_data` (BenefitPay) or redirect (Benefit PG `_links.redirect`)
- Stripe: `requires_*` status + `client_secret` (+ optional `next_action.redirect_to_url`)
- Adyen: `resultCode` + `action` (redirect/challenge/threeDS2)
- HyperPay: `checkoutId` + `resourcePath`
- PayTabs: `redirect_url` (HPP)

**Seam:** normalize to `{ status, action: { type: 'redirect'|'qr'|'client_secret'|'hosted_page'|'none', url?/data?/secret?, gateway_reference } }`. The driver maps its state machine → a small enum (`PENDING_AUTH`, `AUTHED`, `CAPTURED`, `FAILED`, `REFUNDED`, `VOIDED`, `REQUIRES_3DS`). This is where ~80% of driver code lives.

### 2. `tokenize` — publishable-key, hosted-fields capability
- Client-side, no PCI cert: Tap Card SDK (`pk_test_`), Moyasar form (`pk_test_` → `POST /v1/tokens`), Stripe Elements (`pk_test_`), Checkout.com Flow (`payment-sessions` + `tokenize()`), Adyen Secured Fields, HyperPay COPYandPAY.
- Server-side tokenization exists but **requires PCI cert** (Tap explicitly). PayTabs uses `client_key` for own-form.
- **Seam:** `tokenizeCapability()` per driver + a normalized token object passed into `createPayment` as the card source. Raw-PAN path should be **disabled by default** in the abstraction (SAQ A posture).

### 3. Auth/capture/refund **operations**
- Sale vs auth+separate-capture: Stripe (`capture`), Adyen (`captures`), Checkout.com (`captures`), Tap (`/v2/charges` vs `/v2/authorize`), PayTabs (`tran_type: sale|auth`), HyperPay (widget capture modes), Moyasar (`manual:true` → `authorized`).
- Refund: Tap `/v2/charges/{id}/refunds`, Stripe `/v1/refunds`, Adyen `/refunds`, Checkout `/payments/{id}/refunds`, PayTabs refund tran, HyperPay `paymentType=RF`.
- **Seam:** `authorize`, `capture`, `refund` (+ `void`/`reverse`) as first-class ops; drivers that don't separate capture (Moyasar default sale) just autocomplete capture.

### 4. Webhook → normalized event
- Raw-body HMAC header: **Stripe** (`Stripe-Signature`), **Checkout.com** (`Cko-Signature`) — must verify un-deserialized bytes.
- In-payload / field-subset HMAC: **Adyen** (`additionalData.hmacSignature`), **Tap** (`hashstring` header, computed over selected fields).
- Unsigned, re-fetch for truth: **HyperPay** (widget/notification flow).
- Signature-verifiable form POST: **PayTabs** IPN.
- **Seam:** per-driver `verifyWebhook(rawBody, headers, secret) → { event, data }`, then normalize `{ type: payment.succeeded|failed|captured|refunded|…, gateway_ref, amount, currency, status }`. Keep **raw body** in the webhook engine (never pre-parse for HMAC signers).

### 5. Amount & currency model (cross-cutting, non-negotiable)
- **BHD/KWD/OMR/JOD are 3-decimal** (fils: BHD 3.000); AED/SAR 2-decimal. Stripe/Adyen/Checkout use integer minor units with a currency-aware exponent; Tap's webhook example explicitly flags BHD-3.000 rounding; PayTabs uses strings.
- **Seam:** the abstraction must carry `{ amount, currency, exponent }` (minor-unit integer + 3-letter code resolved to exponent per currency). Never hardcode ×100.

---

## Mock scenario mapping

SPEC 4.3 scenarios vs real gateway behavior:

| SPEC scenario | Real-world anchor | Realistic via | Notes |
|---|---|---|---|
| **4242 success** | Canonical Stripe/Checkout.com test card `4242 4242 4242 4242` = approved. | Stripe, Checkout.com, Tap, Moyasar, PayTabs test cards | This is why 4242 exists — real gateways use it. Mock should return 200 + `payment.succeeded`. |
| **0002 insufficient funds** | Stripe `4000 0000 0000 0002` = **generic decline** (not literal insufficient). True "insufficient_funds" is `4000 0000 0000 9995`. Checkout/Moyasar use `4000 0000 0000 0002` as decline. | Stripe (9995), Checkout.com (0002), Benefit PG test cards (`…551…` → code 51 insufficient) | SPEC's "0002 = insufficient" is **slightly wrong** — 0002 is a generic decline; insufficient is code 51 / Stripe 9995. Recommendation: keep 4242 success, 0002 **generic_decline**, and add a real insufficient card (Stripe 9995 or HyperPay code 51) if the mock needs distinction. 402 response matches generic-decline semantics. |
| **9999 timeout** | No card code means timeout. Stripe `4000 0000 0000 9995`… no. Real timeouts are **network/gateway-level** (Adyen `resultCode: Pending` for acquirer systems down; HyperPay/Moyasar 5xx/no-response). | Any driver under simulated latency/no-response; not a card-number behavior | Mock should **hold/sleep** the request or return a gateway-timeout error, not a decline. There is no real "9999 card". |
| **3D01 3DS challenge** | Stripe `4000 0027 6000 3184` → challenge. PayTabs `4000000000000002` (3DS-enrolled). Moyasar `initiated`+`transaction_url`. HyperPay `800.100.152`/3DS result codes. Adyen `ChallengeShopper`. | Stripe, PayTabs, Moyasar, Adyen, Checkout.com (`3ds.enabled`) | Realistic as a redirect/challenge URL the mock serves as an interactive page (matches SPEC "Mock 3DS Web Challenge"). |
| **BenefitPay QR → Fawri+ payout event** | Real BenefitPay is **QR-initiated wallet payment** (30s, ISO 20022); "Fawri+" is the instant credit leg. Checkout.com BenefitPay flow: 202 `Pending` → `source.qr_data` → scan → `payment_captured` webhook. Tap `src_bh.benefit` → `transaction.url` PIN page. | Checkout.com sandbox (QR + simulator app), Tap sandbox (`src_bh.benefit`) | No public "Fawri+ webhook" to merchants — payout is BENEFIT rail-side. The mock's 1-click "Simulate Scan & Pay" is **more capable than real sandboxes**, which need Benefit's simulator app. Spec is realistic in shape (QR → capture event), just faster than real gates. |

**Consequence for the mock-gateway design (4.3):** implement scenarios as **driver behaviors on the Mock Gateway**, keyed by card suffix, matching the real drivers' status transitions (INITIATED→CAPTURED, requires_*), so switching a route to a real gateway is a config change, not a rewrite.

---

## v1 driver recommendation

| Tier | Drivers | Rationale |
|---|---|---|
| **Must (v1)** | **Mock Gateway** (default), **Tap** (primary local), **Stripe** (global cards), **Moyasar** (KSA/mada) | Covers BenefitPay+Benefit+BHD (Tap), global cards (Stripe), KSA cards/mada/STC Pay (Moyasar); all have free instant sandboxes and client-side tokenization. |
| **Strong secondary** | **Checkout.com** | Direct BenefitPay QR + Benefit PG + BHD + top-tier webhook HMAC; picks up local-rail depth if Tap terms disappoint. |
| **Later** | Adyen (enterprise, GCC acquirer), HyperPay (Saudi mada enterprise), PayTabs (legacy HPP/GCC breadth) | Payload complexity is absorbed by the same 4 seams; no abstraction redesign needed. |
| **Not a driver** | Jaywan, direct BENEFIT | Scheme/rail, not PSP APIs — model as routing/BIN rules and ISO 20022 domain, respectively. |

---

## Sources

**Tap** — Authentication: https://developers.tap.company/docs/authentication · Create charge: https://developers.tap.company/reference/create-a-charge · Create token (PCI note): https://developers.tap.company/reference/create-a-token · Card payments (3DS redirect): https://developers.tap.company/docs/card-payments · Webhook (hashstring HMAC): https://developers.tap.company/docs/webhook · Benefit: https://developers.tap.company/docs/benefit · BenefitPay Web SDK: https://developers.tap.company/docs/benefitpay-web-sdk

**Moyasar** — Auth + sandbox keys: https://docs.moyasar.com/api/authentication · Create payment: https://docs.moyasar.com/api/payments/01-create-payment · Create token: https://docs.moyasar.com/api/other/tokens/create-token · Tokenization (form): https://docs.moyasar.com/guides/references/tokenization · 3DS: https://docs.moyasar.com/guides/3d-secure/3ds-in-a-payment

**HyperPay** — Integration guide: https://www.hyperpay.com/integration-guide/ · Server API spec (signature scheme): https://doc-sdk.hyperpay.io/en/1public/14_api_specification.html · Callbacks: https://doc-sdk.hyperpay.io/en/4callback/ · HyperCard API: https://doc-api.hyperpay.io/en/

**PayTabs** — HPP request + test cards: https://support.paytabs.com/en/support/solutions/articles/60000992876 · Test cards: https://support.paytabs.com/en/support/solutions/articles/60000712315 · IPN/callback handling: https://support.paytabs.com/en/support/solutions/articles/60000978893 · Technical portal: https://docs.paytabs.com/manuals/Backend-Web-Packages/NodeJs/NodeJS-Step-3-Initiating-the-payment/Initiating-The-Payment/

**Stripe** — Payment Intents/Setup Intents (API): https://docs.stripe.com/api/setup_intents/create · Webhook signatures (raw-body HMAC): https://docs.stripe.com/webhooks/signatures · Testing/test cards: https://docs.stripe.com/testing · Test cards & webhooks reference: https://tessl.io/registry/testland/stripe-test-cards-and-webhooks

**Checkout.com** — BenefitPay (QR flow + simulator + webhooks): https://checkoutdocs.readme.io/docs/benefit-pay · Benefit PG (API-only): https://docs-backend.sandbox.checkout.com/docs/payments/add-payment-methods/benefit-payment-gateway/api-only · Tokenize credentials (Flow/Payment Sessions): https://www.checkout.com/docs/payments/store-and-manage-credentials/tokenize-credentials · Webhooks/CKO-Signature: https://checkoutdocs.readme.io/docs/webhooks + https://www.checkout.com/docs/developer-resources/event-notifications/receive-webhooks/configure-your-webhook-server · 3DS: https://docs-backend.checkout.com/docs/payments/authenticate-payments

**Adyen** — Checkout v68 API: https://docs.adyen.com/api-explorer/Checkout/68/overview · Capture: https://docs.adyen.com/api-explorer/Checkout/68/post/payments/(paymentPspReference)/captures · Refund: https://docs.adyen.com/api-explorer/Checkout/68/post/payments/(paymentPspReference)/refunds · Submit details/3DS: https://docs.adyen.com/api-explorer/Checkout/68/post/payments/details · HMAC webhooks: https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures

**Jaywan** — N-Genius Jaywan (BIN ranges, flow): https://docs.ngenius-payments.com/docs/jaywan · Jaywan scheme architecture (AEP/CBUAE): https://medium.com/@seyhunak/designing-architectural-jaywan-domestic-card-scheme-integration-for-a-uae-banks-002181f68680

**BENEFIT / Fawri+** — BenefitPay Business Account / Fawri+ (app, bank-approval): https://startupbahrain.com/blog/add-your-business-account-in-benefitpay-and-start-taking-payments · Bahrain rails (Fawri/Fawri+, ISO 20022): https://clearingpost.com/insights/bahrain-payment-infrastructure-rtgs-fawri-benefit-guide/ · Benefit provider overview (sandbox: yes, webhooks: yes): https://paymentproviders.io/providers/benefit · Benefit Payment Gateway docs: https://benefit.bh/business/payment-gateway/
