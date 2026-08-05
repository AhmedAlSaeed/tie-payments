# Unified Payment Orchestration & Developer Platform Specification

A comprehensive technical architecture document for a Payment Orchestration, Invoicing, and Billing Infrastructure Layer operating in Bahrain and the GCC.

## 1. Executive Summary & Legal Framework

### 1.1 Business Model

The platform operates as a Payment Technical Service Provider (TSP) / Payment Orchestration Engine (similar to Hyperswitch, Spreedly, or Primer). It provides a single API/SDK integration point for merchants to manage payment gateways, invoicing, recurring subscriptions, and webhooks.

### 1.2 Regulatory Classification (Bahrain)

**Non-Possession of Funds:** The platform functions strictly as a software routing, data processing, and tokenization layer. Money flows directly from the customer, through the payment gateway/processor, to the merchant's bank account.

**Regulatory Exemption:** Under CBB Rulebook Volume 5 (PS-1.1.3), entities that process, transmit, or store payment data without taking possession of client funds at any time are exempt from CBB financial provider licensing.

**Commercial Registration (Sijilat / MOIC):** Operates under standard IT and software commercial activity codes:

- 6201: Computer Programming Activities (API & SDK development)
- 6202: Computer Consultancy & Facilities Management
- 6311: Data Processing, Hosting, and Related Activities

**Compliance Standards:**

- **PCI-DSS Scope:** Kept at SAQ A or SAQ A-EP via client-side gateway tokenization and hosted checkout fields. Raw credit card numbers (PAN/CVV) never touch platform servers.
- **Bahrain PDPL (Law No. 30 of 2018):** Platform acts as a Data Processor storing non-sensitive metadata, logs, and customer profiles.
- **NBR VAT Compliance:** Built-in invoice generator supporting Bahrain 5% VAT rules and TIN itemization.

## 2. System Architecture & Pillars

The platform is structured into five core decoupled engine pillars:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Merchant Application / SDK                         │
└────────────────────────────────────┬────────────────────────────────────┘
                                      │
┌────────────────────────────────────▼────────────────────────────────────┐
│                             API Gateway                                 │
├─────────────────┬──────────────────┬──────────────────┬─────────────────┤
│ Pillar 1:       │ Pillar 2:        │ Pillar 3:        │ Pillar 4:       │
│ Gateway         │ Billing &        │ Subscriptions    │ Event Bus &     │
│ Orchestrator    │ Invoicing        │ Engine           │ Webhook Dispatch│
└────────┬────────┴────────┬─────────┴────────┬─────────┴────────┬────────┘
         │                 │                  │                  │
┌────────▼─────────────────▼──────────────────▼──────────────────▼────────┐
│             Pillar 5: Dynamic Schema & Customization Engine             │
└─────────────────────────────────────────────────────────────────────────┘
```

### Pillar 1: Gateway Orchestration & Smart Routing

- **Unified API Abstraction:** Standardized payload format for local (BENEFIT / BenefitPay, Jaywan), regional (Tap, Moyasar, HyperPay, PayTabs), and global gateways (Stripe, Checkout.com, Adyen).
- **Rule Engine:** Dynamic transaction routing based on currency (BHD, SAR, USD), card type, transaction amount, lowest processing fee, or automated gateway failover.
- **Cross-Gateway Tokenization:** Maps processor-specific card tokens to a unified platform customer profile.

### Pillar 2: Billing & Invoicing Engine

- **Flexible Line Items:** Tax rules (Bahrain 5% VAT), percentage/flat discounts, multi-currency conversion, and custom line items.
- **Hosted Payment Pages (HPP) & Links:** White-labeled checkout pages and SMS/WhatsApp payment links.
- **Lifecycle State Machine:** Strictly enforced status flows (draft → issued → partially_paid → paid → voided / overdue).

### Pillar 3: Subscriptions & Recurring Billing

- **Flexible Schedules:** Daily, weekly, monthly, annual, or custom cron intervals.
- **Pricing Models:** Flat-rate, seat-based, usage-based/metered, and tiered pricing structures.
- **Smart Dunning:** Automatic retry schedules for failed payments before triggering subscription cancellation.

### Pillar 4: Event Bus & Webhook Engine

- **Standardized Event Delivery:** Normalizes varied gateway webhooks into uniform platform events (e.g., payment.succeeded, invoice.payment_failed, subscription.canceled).
- **Reliable Propagation:** Signed payloads using HMAC-SHA256, exponential backoff retries, idempotency key verification, and manual replay logs in the Admin UI.

### Pillar 5: Dynamic Customization & Schema Engine

- **EAV / JSONB Extensibility:** Extensible metadata storage on core models allowing arbitrary key-value attachments.
- **Schema-Driven Form Generation:** JSON Schema definitions converted automatically into UI inputs inside SDK checkout forms.

## 3. Dynamic Customizability & Admin Config

### 3.1 Theme & UI Customization

Merchants can configure checkout appearances per tenant via the Admin Portal:

| Configuration Area | Options / Capabilities |
| --- | --- |
| Visual Branding | Primary/Secondary colors, border-radius, dark/light mode toggle, custom CSS injection. |
| Assets & Info | Company logo, brand name, support email, localized terms & privacy policy links. |
| Localized Strings | Multi-language translation overrides (e.g., English & Arabic RTL support). |

### 3.2 Dynamic Field Schema Engine

Admins can define custom fields for entities without performing database schema migrations:

```json
{
  "target_entity": "invoice",
  "fields": [
    {
      "key": "po_number",
      "label": "Purchase Order Number",
      "type": "string",
      "required": true,
      "validation": { "min": 3, "max": 20 }
    },
    {
      "key": "cost_center",
      "label": "Cost Center Code",
      "type": "select",
      "options": ["ENG-101", "MKT-202", "FIN-303"],
      "required": false
    }
  ]
}
```

**SDK Auto-Rendering:** The SDK dynamically builds input fields matching the merchant's schema.

**Database Querying:** Values are stored in indexed metadata JSONB columns, queryable via PostgreSQL JSON path operations (metadata->>'po_number').

## 4. Sandbox & Testing Environment (1-Minute Setup)

### 4.1 Dual-Environment Data Partitioning

**API Key Namespacing:**

- Test: pk_test_... / sk_test_...
- Live: pk_live_... / sk_live_...

**Zero-Leak Isolation:** Every entity includes an environment ENUM (test | live). Database queries strictly append `WHERE environment = req.environment`.

### 4.2 Developer Onboarding Flow (< 60 Seconds)

1. **Sign Up & Seed Credentials: Instant Access.** Developer signs up (Email + Password). System automatically generates sk_test_... and pre-activates the built-in Mock Gateway Driver.
2. **Run Pre-Configured Test SDK: Zero Gateways Needed.** Copy-paste 1-line SDK code snippet. Test environment works immediately without needing real bank or gateway credentials.
3. **Trigger Test Payments & Webhooks: Interactive Simulation.** Simulate payments using test cards or the BenefitPay Mock QR Code (includes 1-click "Simulate Scan & Pay"). Instantly inspect incoming webhooks in the built-in Admin Log Streamer.

### 4.3 Mock Gateway Testing Matrix

| Test Scenario | Card / Trigger Input | Simulated System Response |
| --- | --- | --- |
| Success Case | Ending in 4242 | 200 OK → payment.succeeded |
| Insufficient Funds | Ending in 0002 | 402 Payment Required → payment.failed |
| Gateway Timeout | Ending in 9999 | Gateway Timeout simulation |
| 3DS Challenge | Ending in 3D01 | Redirects to interactive Mock 3DS Web Challenge |
| BenefitPay QR | Click "Test Pay" on QR | Instant Fawri+ payout event simulation |

## 5. Ecosystem & Community Plugins

### 5.1 Universal Extension Architecture

Community plugins operate as lightweight wrappers around the platform's Hosted Payment Page (HPP) / Session API to keep merchant stores lightweight, maintainable, and PCI-safe.

```
┌────────────────────────────────────────────────────────────────────────┐
│          E-Commerce Store (Odoo / Magento / WooCommerce)               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 1. Create Checkout Session
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Orchestration API Server                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 2. Return Session Token & URL
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Hosted Checkout / Modal SDK (iFrame)                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 3. Dispatch Signed Webhook Event
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Store Webhook Handler (Order Paid)                    │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Supported Platforms & Deliverables

- **Odoo Module (Python / OWL):** Hooks into payment.provider and payment.transaction models.
- **Magento 2 Extension (PHP / Adobe Commerce):** Implements Magento\Payment gateway interfaces and Knockout.js checkout components.
- **WooCommerce Plugin (PHP / WordPress):** Extends WC_Payment_Gateway with custom settings and asynchronous webhook callbacks.
- **SDK Repositories:** Official open-source wrappers maintained in Node.js/TypeScript, Python, and PHP.
