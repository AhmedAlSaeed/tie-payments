# Single-currency invoices — no conversion in the engine

SPEC's Pillar 2 lists "multi-currency conversion" as a line-item feature, but
the invoice engine deliberately ships single-currency. A Stripe invoice is
strictly one currency: every line and every payment amounts in that currency,
and Stripe does not convert. Cross-currency conversion, if ever needed, is a
separate rounding/instruction layer and out of scope for the core invoice
engine (a currency/exponent concern lives in `CURRENCY_EXPONENT`). Engineers may
reach for conversion here; the boundary is intentional and matches the product
target.