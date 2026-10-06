# 20 — ticketing

| | |
|---|---|
| **Sprint** | 15 |
| **Phase** | **3** |
| **Depends on** | events, payments, identity, notifications |
| **Owns** | `ticket_types`, `ticket_orders`, `ticket_holds`, `tickets`, `ticket_scans` |
| **Rule prefix** | `ticketing R*` |
| **Risk** | **Money + capacity** |

Spectator and attendee tickets with QR codes: finals day, exhibition matches, clinics with a gate.

**A player's entry is not a ticket.** Entrants check in with their registration's QR
(`registration R13`, Phase 1), and that path never depends on this Phase 3 module.

---

## Service interface

```ts
createType(actor, eventId, input) / updateType(actor, typeId, patch)  => TicketType
typesFor(eventId)                                        => TicketType[]
quote(typeId, quantity)                                  => PriceQuote     // R2
beginOrder(actor, { typeId, quantity, attendeeNames[] }) => { order, paymentOrder | null }
confirmFromPayment(paymentId)                            => TicketOrder    // payments calls this
failFromPayment(paymentId, reason)                       => TicketOrder
expireHold(holdId)                                       => void
myTickets(actor, page)                                   => Page<Ticket>
transfer(actor, ticketId, email)                         => Ticket         // R5
cancelOrder(actor, orderId)                              => TicketOrder    // R6
scan(staff, code)                                        => ScanResult     // R4
manifest(staff, eventId)                                 => { hashes, issuedAt }   // offline scanning
uploadScans(staff, scans[])                              => ScanResult[]
salesSummary(actor, eventId)                             => TicketSales    // organizers analytics
```

## GraphQL

```graphql
extend type Event { ticketTypes: [TicketType!]! }

type TicketType {
  id: ID!
  name: String!                # "Finals Day — General"
  priceQuote: PriceQuote!
  remaining: Int!              # subtracts live holds, as events R5
  salesOpenAt: DateTime!
  salesCloseAt: DateTime!
  maxPerOrder: Int!
  refundable: Boolean!
}

type Ticket {
  id: ID!
  event: Event!
  type: TicketType!
  attendeeName: String!
  qrPayload: String!           # owner only; rotates on transfer — R5
  status: TicketStatus!        # VALID | USED | TRANSFERRED | REFUNDED | VOID
}

type Viewer { tickets(first: Int = 20, after: String): TicketConnection! }

Mutation.createTicketType / updateTicketType
Mutation.beginTicketOrder(input: BeginTicketOrderInput!): BeginTicketOrderPayload!
Mutation.transferTicket(input: TransferTicketInput!): TicketPayload!
Mutation.cancelTicketOrder(orderId: ID!): TicketOrderPayload!
Mutation.scanTicket(code: String!): ScanTicketPayload!
Mutation.uploadTicketScans(input: UploadScansInput!): UploadScansPayload!
```

---

## Rules

**R1** — Tickets are distinct from entries. Nothing in registration, tournament or scoring reads a
ticket.

**R2** — Price comes from one pure `quote()` per ticket type (entry price + platform fee + tax), the
same shape as `events R3`. Quantity is decided under `FOR UPDATE` on the ticket type, counting sold
tickets plus unexpired holds. An insert that would oversell returns zero rows and maps to
`TICKETS_SOLD_OUT`. This is `registration R4`/`R5` applied to a second inventory.

**R3** — Tickets are issued **only** on a verified `payment.captured` for subject `ticket_order`
(`payments R20`), or immediately when the price is zero. The hold TTL is 10 minutes.

**R4** — Each ticket has a **128-bit random code**, stored hashed. The QR carries the code. `scan`
requires a `scorer`-or-higher event grant. The first valid scan marks the ticket `used`; any later
scan returns `TICKET_ALREADY_USED` **with the first scan's time and device**, never a silent
success. Staff devices may download a manifest of code hashes for offline scanning and upload
scans on reconnect. Conflicts resolve first-scan-wins by device timestamp, and duplicates are
flagged.

**R5** — A ticket may be transferred **once**, to an email address, before the event starts.
Transfer **rotates the code**, so the original QR stops working immediately.

**R6** — Cancelling an event voids and fully refunds every ticket (extends `events R7`). A buyer
may cancel only `refundable` types before `salesCloseAt`. The platform fee is retained, and the
retention is disclosed in the quote.

**R7** — General admission only in Phase 3: no seat maps. Attendee PII is a name per ticket and the
buyer's email.

**R8** — `maxPerOrder` is at most 10, and a user may hold at most 20 tickets per event, which limits
resale scalping.

---

## Schema

```sql
CREATE TABLE ticket_types (
  id              uuid PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES events(id),
  name            text NOT NULL,
  price_paise     bigint NOT NULL CHECK (price_paise >= 0),
  platform_fee_paise bigint NOT NULL DEFAULT 0,
  tax_bps         integer NOT NULL DEFAULT 1800,
  quantity        integer NOT NULL CHECK (quantity > 0),
  max_per_order   smallint NOT NULL DEFAULT 4 CHECK (max_per_order BETWEEN 1 AND 10),
  refundable      boolean NOT NULL DEFAULT true,
  sales_open_at   timestamptz NOT NULL,
  sales_close_at  timestamptz NOT NULL CHECK (sales_close_at > sales_open_at),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ticket_types (event_id);

CREATE TABLE ticket_orders (
  id              uuid PRIMARY KEY,
  ticket_type_id  uuid NOT NULL REFERENCES ticket_types(id),
  buyer_user_id   uuid NOT NULL REFERENCES users(id),
  quantity        smallint NOT NULL CHECK (quantity > 0),
  amount_paise    bigint NOT NULL,                 -- frozen quote (R2)
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','paid','failed','expired','cancelled','refunded')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ticket_holds (
  id              uuid PRIMARY KEY,
  ticket_type_id  uuid NOT NULL REFERENCES ticket_types(id),
  ticket_order_id uuid NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
  quantity        smallint NOT NULL,
  expires_at      timestamptz NOT NULL,
  released_at     timestamptz
);
CREATE INDEX ticket_holds_active_idx ON ticket_holds (ticket_type_id) WHERE released_at IS NULL;

CREATE TABLE tickets (
  id              uuid PRIMARY KEY,
  ticket_order_id uuid NOT NULL REFERENCES ticket_orders(id),
  event_id        uuid NOT NULL REFERENCES events(id),
  holder_email    citext NOT NULL,
  holder_user_id  uuid REFERENCES users(id),
  attendee_name   text NOT NULL,
  code_hash       text UNIQUE NOT NULL,            -- R4; plaintext code never stored
  code_version    smallint NOT NULL DEFAULT 1,     -- bumps on transfer (R5)
  transferred     boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'valid' CHECK (status IN
                    ('valid','used','refunded','void')),
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tickets (event_id);
CREATE INDEX ON tickets (holder_user_id);

CREATE TABLE ticket_scans (
  id              bigserial PRIMARY KEY,
  ticket_id       uuid REFERENCES tickets(id),     -- null when the code matched nothing
  event_id        uuid NOT NULL REFERENCES events(id),
  scanned_by      uuid NOT NULL REFERENCES users(id),
  device_id       text NOT NULL,
  scanned_at      timestamptz NOT NULL,            -- device clock (R4)
  result          text NOT NULL CHECK (result IN ('admitted','already_used','invalid','duplicate_offline')),
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `TICKETS_SOLD_OUT` | user | Sold-out state — R2 |
| `SALES_CLOSED` | user | Outside the sales window |
| `ORDER_LIMIT` | user | R8 |
| `TICKET_ALREADY_USED` | user | Red scan screen with first-scan time — R4 |
| `TICKET_INVALID` | user | Red scan screen |
| `TRANSFER_NOT_ALLOWED` | user | Already transferred, or event started — R5 |
| `TICKET_HOLD_EXPIRED` | user | Return to ticket selection |

## Emits

| Event | Consumers |
|---|---|
| `ticket.issued` | notifications, organizers (analytics) |
| `ticket.scanned` | organizers (analytics) |
| `ticket_order.refunded` | notifications |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `release-ticket-hold` | Delayed +10 min | 3 × exp | Alert |
| `sweep-ticket-holds` | Every 5 min | 3 × exp | Alert |
| `void-tickets-on-cancel` | `event.cancelled` | 5 × exp | **Page** — refunds owed |

---

## Done when

Two hundred concurrent buyers for 100 tickets produce **exactly 100** issued tickets. A transferred
ticket's original QR is rejected at the gate. The same ticket scanned offline on two devices
resolves to one admission and one flagged duplicate. Cancelling the event refunds every ticket
exactly once.

---

## Implementation checklist

- [ ] **Concurrency test first**, as in registration
- [ ] Migration `020_ticketing.sql`
- [ ] `quote()` pure function; `FOR UPDATE` + holds inventory query (R2)
- [ ] Payment subject `ticket_order` (R3, payments R20)
- [ ] Random code generation, hashed storage, QR payload (R4)
- [ ] Scan endpoint + offline manifest + upload with first-scan-wins (R4)
- [ ] One-time transfer with code rotation (R5)
- [ ] Refund paths for event cancel and buyer cancel (R6)
- [ ] Tests naming R2, R3, R4, R5, R6, R8
