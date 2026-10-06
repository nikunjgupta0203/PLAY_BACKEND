# ADR 0002 — Email OTP via Resend, not SMS

**Status:** Accepted
**Date:** 2026-09-05
**Deciders:** Backend
**Supersedes:** the phone-first identity model in ADR 0001 and the original architecture

---

## Context

The original design made **phone number** the primary identity, with six-digit OTP codes delivered
by SMS through MSG91 — chosen because the launch market is India, where phone-first signup is the
norm and DLT-registered SMS templates are a regulatory requirement.

That is now changed: **email is the primary identity, and verification codes are delivered by email
through Resend.** MSG91 is removed from the stack entirely.

## The decision

- `users.email` is the unique identity. `users.phone_e164` becomes **optional** contact information.
- `otp_challenges` are keyed by email.
- Resend is the only transactional email provider. There is no SMS provider.
- Partner invitations in `registration` are sent to an **email address**, not a phone number.

## Why this is a reasonable trade

**What it buys:**

- **One provider, one integration.** SMS in India means DLT registration, template approval,
  sender-ID provisioning and per-template compliance. Email needs a verified domain and correct DNS.
  The second is a morning's work; the first is a procurement exercise.
- **No per-message cost cliff.** SMS is metered per send and priced high enough that an unthrottled
  OTP endpoint is a real financial risk. Email is cheap enough that the rate limits become an abuse
  control rather than a budget control.
- **Email is already needed.** Receipts, refund confirmations and organizer messages all want email.
  Adding SMS on top means two channels to build, template, test and monitor.
- **Deliverability is diagnosable.** Resend exposes per-message delivery, bounce and complaint
  events by webhook. When a user says "I never got the code", there is a record. SMS delivery in
  India is frequently a black hole.

**What it costs — stated plainly:**

- **Email OTP is slower and less reliable than SMS at the moment of signup.** Codes land in spam,
  arrive in 30 seconds instead of 3, or sit behind a corporate filter. This is the single biggest
  risk to signup conversion, and it is a real one.
- **Phone-first is the norm in India.** Asking for an email address at signup is more friction than
  asking for a phone number, particularly for the recreational-player audience this product targets.
- **Disposable email addresses are trivial to obtain**, where phone numbers are not. A paid platform
  with a refund policy has a real incentive to make throwaway accounts inconvenient. See C3.
- **Partner invites get worse.** Inviting a doubles partner by phone number matches how players
  actually coordinate — they have each other's numbers, not each other's emails. This is the
  consequence most likely to show up as a drop in doubles registrations. See C4.

## Consequences

### C1 — Domain authentication before anything else

Resend will not deliver reliably from an unauthenticated domain. Before Sprint 1 work on identity
begins: verify the sending domain in Resend and publish **SPF, DKIM and DMARC** records. Send OTP
from a dedicated subdomain (`auth.pl4y.app`) kept separate from marketing mail, so a future campaign
cannot damage the reputation that logins depend on.

### C2 — Deliverability is a monitored metric, not an assumption

Subscribe to Resend's webhooks and record `delivered`, `bounced` and `complained` per message.
Dashboard the OTP funnel — **requested → delivered → verified** — from day one. A drop in the
delivered-to-verified ratio is a signup outage, and without this instrumentation it looks like
"conversion is down."

Hard bounces mark the address unusable and block further sends to it; the user is told to correct
their address rather than being left retrying into a void.

### C3 — Disposable-domain policy

Maintain a blocklist of disposable email domains, checked at `requestOtp`. This is not spam
prevention — it is refund-fraud prevention on a platform that takes money and gives it back.
Rejection is a normal user error (`EMAIL_DOMAIN_NOT_ALLOWED`), not a system error.

### C4 — Partner invites change shape

`registration_invites.invited_phone` becomes `invited_email`, and `registration R7` (eligibility at
accept, not invite) is unchanged. But the invite is now something the captain has to look up rather
than something they already have in their contacts.

**Mitigation worth building in Sprint 4:** let the captain invite an existing PL4Y player by
searching for them in-app — display name or email — and fall back to typing an email address only
when the partner has no account. That converts the common case from "type an email you may not know"
into "pick the person you always play with."

**Watch this metric:** doubles registrations that reach `awaiting_partner` but never reach
`payment_pending`. If that ratio is bad, revisit this ADR rather than blaming the funnel.

### C5 — Phone stays in the schema

`users.phone_e164` remains as **optional, unverified** contact information. Organizers routinely
need to reach players on a tournament morning, and a phone number in the registration record is
worth having even when it is not an identity. It is nullable, it is not unique, and it is never an
authentication factor.

Keeping the column also means re-introducing SMS later — as a second factor, or as a fallback
channel when email bounces — is additive rather than a migration.

## Revisit this if

- The delivered-to-verified ratio in C2 sits below ~90%, which would mean email is losing signups
  that SMS would have kept.
- The doubles funnel metric in C4 degrades materially against singles.
- The product expands to a market where email-first signup is even less natural than it is in India.

In any of those cases the fix is **additive**: add SMS as a second OTP channel alongside email,
keyed off the existing optional `phone_e164`. The `otp_challenges` table gains a `channel` column
and nothing else changes.

## References

- `modules/01-identity.md` — the full identity spec
- `modules/06-registration.md` R7 — partner eligibility at accept
- `modules/11-notifications.md` — the notification channels (push and in-app; email is transactional only)
