# 23 — vendors (PL4Y Shop vendor partnership form)

A shareable, sign-in-free form for brands, retailers, distributors and
individual sellers who want to sell on PL4Y Shop, and its review in the admin
portal. Form app: `PLAY_FRONTEND/apps/vendors`. Portal: `apps/admin` → `/vendors`.

## Steps

1. **Seller details** — seller type, store / brand name (optional for an
   individual), contact name, WhatsApp, email, city, website or Instagram.
2. **Product details** — sports, number of products, price range, inventory
   (make time asked only for made-to-order or mixed), catalogue link.
3. **Fulfilment & partnership** — dispatch time, packaging, current sales
   channels, GST status (GSTIN asked only when registered, optional),
   preferred commercial model, notes.
4. **Review & submit** — one consent.

Questions: `src/modules/vendors/service/form.ts` (the contract). The form app
keeps a copy in `src/lib/form.ts`; keep the two in step.

No bank details or identity documents are asked for at this stage.

## Rules

- **R1** One application per submission. Nobody signs in.
- **R2** Answers are checked with the partnerships answer checker. Store name
  required except for an individual; highest price ≥ lowest; a GSTIN has the
  15-character GSTIN shape (stored upper-case).
- **R3** The same client token submitted again returns the first application.
- **R4** Seller confirmation + team email, both best effort. Team inbox:
  `VENDOR_NOTIFY_EMAILS`, or `PARTNERSHIP_NOTIFY_EMAILS` when empty.
- **R5** 10/hour and 30/day per IP, 5/day per email. A filled hidden field
  gets a fake receipt and stores nothing.
- **R6** Statuses: `new` → `reviewing` → `more_info_needed` → `approved` /
  `rejected`. Every move is kept in `vendor_status_changes` with who made it.
  Staff notes in `vendor_notes`, never shown to the seller. Reading: any
  platform staff. Changing: admin and support.

## Tables (migration 051)

`vendor_applications`, `vendor_notes`, `vendor_status_changes`.

## Deploy

Backend (migration 051) → portal → vendors app. The vendors app calls the API
from the browser, so its origin must be in `CORS_ORIGINS`.
