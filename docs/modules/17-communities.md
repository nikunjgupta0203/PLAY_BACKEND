# 17 — communities

| | |
|---|---|
| **Sprint** | 11 · rewritten 2026-10-22 from "Community Types and Membership Structure" |
| **Phase** | **2** (free) · paid memberships follow (R8) |
| **Depends on** | identity, sport, profile, notifications · payments for R8 |
| **Owns** | `communities`, `community_members`, `community_join_requests`, `community_posts`, `community_messages` |
| **Rule prefix** | `communities R*` |
| **Build plan** | `PLAY_FRONTEND/docs/communities-plan.md` |

Clubs, groups and teams: the durable social unit that outlives any single game or tournament.
Two independent choices at creation — **visibility** (public / private) and **access**
(free / paid) — give four types. Who finds a community, how they join and what they see follow
from those two choices.

This rewrite replaces the earlier draft (kinds club/group/team, announcements only, no money,
private = invisible). The product doc asks for paid memberships, private communities that can
still be listed, and a members' feed and chat.

| Type | Label | Discover | Join |
|---|---|---|---|
| Free Public | Free · Public | Listed | Join — at once |
| Free Private | Free · Private | Listed with a lock if the creator allows, else invite link only | Request → admin approves |
| Paid Public | Paid · Public | Listed | Join & pay |
| Paid Private | Paid · Private | As free private | Request → approve → pay |

Members are stored by **user id** (like games); the API takes and returns player ids.

---

## Service interface

```ts
create(actor, input) / update(actor, id, patch) / remove(actor, id)   => Community
lookup({ id | slug | inviteCode }, viewerUserId)                       => Community | null   // R2
search(filter, page)                                                   => Page<Community>     // R2
viewers(communityIds, userId) / viewerOf(id, userId)                   => Viewer              // the button
join(actor, id, inviteCode?)                                           => Community           // R3
requestToJoin(actor, id, { note?, inviteCode? })                       => { community, request | null }
cancelRequest(actor, requestId) / respond(actor, requestId, approve)
leave / removeMember / setRole / transferOwnership / resetInvite
members(community, viewerUserId, page) / joinRequests(actor, id)       // R6, R5
listForUser(userId) / requestsForUser(userId) / isMember(id, userId) / roleOf(id, userId)
sweep()                                                                // R4, daily
```

## GraphQL

```graphql
Query.community(id: ID, slug: String, inviteCode: String): Community
Query.communities(search, sportId, city, access, sort: RECENT|POPULAR, notJoined, first, after): CommunityConnection!
Query.myCommunities: [Community!]!
Query.myCommunityRequests: [CommunityJoinRequest!]!

type Community {
  id slug name description sport city coverUrl
  visibility: PUBLIC|PRIVATE  discoverable  access: FREE|PAID  pricePaise  billing: ONE_TIME|MONTHLY|YEARLY  benefits
  memberCount owner createdAt hidden
  viewerState: NONE|REQUESTED|APPROVED_TO_PAY|MEMBER|EXPIRED|REMOVED
  viewerRole viewerRequest
  inviteCode pendingRequestCount joinRequests        # admins; null / 0 / [] for everyone else
  members(first, after): CommunityMemberConnection!  # R6
}

createCommunity · updateCommunity · deleteCommunity · communityCoverUploadSignature
joinCommunity · requestToJoinCommunity · cancelCommunityRequest · respondToCommunityRequest
leaveCommunity · removeCommunityMember · setCommunityRole · transferCommunityOwnership · resetCommunityInvite
```

Notifications target a community by `{ kind: 'community', id }` (notifications R9).

---

## Rules

**R1** — Visibility (`public` | `private`) and access (`free` | `paid`) are chosen at creation
and **fixed**. A paid community always has a price and a period (`one_time`, `monthly`,
`yearly`); a free one has neither (CHECK `communities_paid_check`). The price and the benefits can
change; a new price applies to the next payment only.

**R2** — Discover lists public communities and private ones whose creator left `discoverable`
on. An unlisted private community is reachable only through its **invite code**, or by someone
it already knows (a member, a pending or approved asker); to anyone else it is indistinguishable
from a missing one. Hidden (staff) and deleted communities are never listed; a hidden one stays
readable to its own members.

**R3** — Joining:
- free public → member at once; the owner is told (`community.member_joined`);
- private → a request; the owner and admins are told (`community.join_request`);
- paid → a payment (R8); until R8 ships, `joinCommunity` refuses with `PAYMENT_REQUIRED`;
- the invite code lets a person into a free private community at once, and counts as an
  approval for a paid private one (they still pay).

**R4** — One open request (`pending` or `approved`) per person per community (partial unique
index). A pending request lapses after **30 days**. A paid private approval gives the asker
**7 days** to pay, then lapses. The daily `sweep-communities` job does both. The asker can
withdraw either.

**R5** — Roles are `owner`, `admin`, `member`, with **exactly one active owner** (partial unique
index). The creator is the owner and first member. The owner cannot leave
(`OWNER_MUST_TRANSFER`) — they hand over, or delete the community. Admins edit the community,
answer requests and remove members; only the owner removes an admin, sets roles, hands over or
deletes.

**R6** — Posts, chat and the member list of a private community are for **active members only**
in every type ("public" is about being found, not about content). A removed member cannot join
or request again.

**R7** — Caps: **5,000** members per community, **10** owned communities per user, price
**₹10 – ₹50,000**. They stop spam communities, not real clubs.

**R8** *(next phase)* — Paid memberships are a payment subject (payments R20). The member pays
the listed price; PL4Y keeps **5%** and the creator earns 95% (no GST: unregistered business).
Paid public: Join & pay. Paid private: approval first, payment second. Monthly and yearly
memberships carry `paid_until`; renewal is manual in v1 (a reminder before the end, `expired`
after it, Renew pays the next period). Creator earnings are held until their payout account is
verified and are paid out monthly through payouts.

**R9** *(next phase)* — The feed (`community_posts`): any member posts text up to 2,000
characters; admins pin and remove. The chat (`community_messages`): members' group thread, up to
1,000 characters a message, soft-deleted, polled by the app while open.

**R10** *(later)* — PL4Y staff can hide a community or a post from the portal (admin R6).

---

## Schema

Migration `047_communities`. Highlights:

- `communities` — `visibility`, `discoverable`, `access`, `price_paise`, `billing`, `benefits`,
  `invite_code` (unique), `member_count` (recounted inside every change that moves it),
  `owner_user_id`, `last_activity_at` (the RECENT sort), `hidden_at`, `deleted_at`.
  `communities_discover_idx` holds only listable rows.
- `community_members` — PK `(community_id, user_id)`; `role`, `status`
  (`active`|`left`|`removed`|`expired`), `paid_until`; `community_members_one_owner_idx`.
- `community_join_requests` — `status` (`pending`|`approved`|`rejected`|`cancelled`|`expired`|`joined`),
  `approval_expires_at` (required when approved); `community_join_requests_one_open_idx`.
- `community_posts`, `community_messages` — R9.

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `COMMUNITY_NOT_FOUND` | user | Also for an unlisted private community without its code — R2 |
| `INVALID_COMMUNITY` | user | Show the message on the form |
| `ALREADY_MEMBER` | user | Open the community |
| `REQUEST_REQUIRED` | user | Offer "Request to join" — R3 |
| `PAYMENT_REQUIRED` | user | Offer "Join & pay" — R3, R8 |
| `JOIN_REQUEST_PENDING` | user | Show the waiting (or pay-now) state — R4 |
| `REQUEST_NOT_FOUND` | user | Refresh the list: it was already answered |
| `REMOVED_FROM_COMMUNITY` | user | R6 |
| `NOT_A_MEMBER` | user | Refresh |
| `OWNER_MUST_TRANSFER` | user | Offer hand-over or delete — R5 |
| `COMMUNITY_FULL` · `COMMUNITY_LIMIT` · `REQUEST_LIMIT` | user | R7, rate limit |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `sweep-communities` | Daily 02:15 UTC | default | Drop (the next day's run catches up) |

---

## Done when

A free public community takes a member in one tap. A private one takes a request that its
admins hear about and answer; an unlisted one is found only with its code. A paid private
approval waits seven days for the payment and then lapses. The owner cannot leave without handing
over, and there is never a second owner. A removed member cannot come back. Tests: `tests/communities.test.ts`
names R1–R7.

## Implementation checklist

- [x] Migration `047_communities` with the one-owner and one-open-request indexes
- [x] Create / edit / delete, cover upload signature, slug and invite code (R1, R5)
- [x] Discover search with sport, city, free/paid, name, RECENT/POPULAR (R2)
- [x] Join, request, approve/reject, withdraw, invite code (R3, R4)
- [x] Leave, remove, roles, hand-over (R5, R6)
- [x] 30-day / 7-day sweep (R4)
- [x] `community.join_request`, `community.request_approved`, `community.request_rejected`, `community.member_joined`
- [x] Tests naming R1–R7
- [x] Feed and chat (R9) — `service/feed.ts`
- [x] Paid memberships (R8) — migration 048, `community_payments` as the third payment subject; Join & pay,
      Pay now after approval, Renew in the last 7 days; reminder 3 days before the end; expiry sweep; owner earnings
- [x] Creator payouts and staff hide (R10) — migration 049, `service/payouts.ts`: monthly per community
      (India months), held until the owner's bank account is verified, marked paid by staff with the UTR;
      `adminSetCommunityHidden`, `adminHideCommunityPost`, `adminCommunities`, `communityPayoutsOpen`
- [ ] Staff refund of a membership payment (and recovery when it was already paid out)

**R10** as built: a payout is gross − PL4Y's 5% (frozen per payment) − GST on the commission
(`COMMISSION_GST_BPS`) − TDS on the gross (`HOST_TDS_BPS`), the host-payout rates. Each payment carries the
payout that settled it (`community_payments.payout_id`), so it is counted once. Job `settle-community-payouts`
runs 06:00 IST on the 1st; `sweep-communities` re-checks held payouts daily.
