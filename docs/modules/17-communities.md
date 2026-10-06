# 17 — communities

| | |
|---|---|
| **Sprint** | 11 |
| **Phase** | **2** |
| **Depends on** | identity, profile, notifications |
| **Owns** | `communities`, `community_members`, `community_join_requests`, `community_announcements` |
| **Rule prefix** | `communities R*` |

Clubs, groups and teams: the durable social unit that outlives any single game or tournament.
It covers "discover communities", persistent "teams" and "team management", and it is where
league team rosters come from.

`games` and `leagues` depend on this module, never the reverse. A community page's games and
league entries are GraphQL fields those modules add to the `Community` type.

---

## Service interface

```ts
create(actor, input)                                   => Community
update(actor, communityId, patch)                      => Community
bySlug(slug) / byId(communityId)                       => Community
join(actor, communityId, note?)                        => Membership | JoinRequest   // R2
respondToRequest(actor, requestId, 'approve' | 'reject') => JoinRequest
invite(actor, communityId, playerIds[])                => void
leave(actor, communityId)                              => void
removeMember(actor, communityId, userId)               => void
setRole(actor, communityId, userId, role)              => Membership
transferOwnership(actor, communityId, userId)          => Community
announce(actor, communityId, { title, body })          => Announcement
membersOf(communityId, page)                           => Page<Membership>
listForUser(userId)                                    => Membership[]
isMember(communityId, userId)                          => boolean     // games calls this
roster(teamId)                                         => Membership[] // registration calls this
```

## GraphQL

```graphql
Query.community(slug: String!): Community
Query.communities(filter: CommunityFilter, first: Int = 20, after: String): CommunityConnection!

type Community implements Node {
  id: ID!
  slug: String!
  kind: CommunityKind!          # CLUB | GROUP | TEAM
  name: String!
  sport: Sport                  # required for TEAM, optional otherwise
  city: String
  logoUrl: String
  description: String
  joinPolicy: JoinPolicy!       # OPEN | APPROVAL | INVITE_ONLY
  visibility: CommunityVisibility!   # PUBLIC | PRIVATE
  memberCount: Int!
  viewerMembership: Membership
  announcements(first: Int = 10, after: String): AnnouncementConnection!
  homeVenue: Venue
}

Mutation.createCommunity(input: CreateCommunityInput!): CommunityPayload!
Mutation.updateCommunity(input: UpdateCommunityInput!): CommunityPayload!
Mutation.joinCommunity(input: JoinCommunityInput!): JoinCommunityPayload!
Mutation.respondToJoinRequest(input: RespondJoinRequestInput!): JoinRequestPayload!
Mutation.inviteToCommunity(input: InviteToCommunityInput!): CommunityPayload!
Mutation.leaveCommunity(communityId: ID!): CommunityPayload!
Mutation.removeCommunityMember(input: RemoveMemberInput!): CommunityPayload!
Mutation.setCommunityRole(input: SetCommunityRoleInput!): CommunityPayload!
Mutation.transferCommunityOwnership(input: TransferOwnershipInput!): CommunityPayload!
Mutation.postCommunityAnnouncement(input: AnnouncementInput!): AnnouncementPayload!
```

`Community` implements `Node` because it is a deep-link target (conventions §4, notifications R9).

---

## Rules

**R1** — There are three kinds. A **club** is formal and often venue- or organizer-affiliated. A
**group** is informal ("Saturday 7am crew"). A **team** is a competitive roster with a captain and
a sport. A kind is fixed at creation.

**R2** — The join policy is `open` (instant membership), `approval` (creates a request) or
`invite_only`. A user has at most one pending request per community, and requests expire after
**30 days**.

**R3** — Roles are `owner`, `admin` and `member`, with **exactly one owner**. The owner cannot leave
without transferring ownership (`OWNER_MUST_TRANSFER`). This deliberately differs from `games R7`:
a community is long-lived, and deleting one because its creator left destroys other people's
group.

**R4** — `public` communities are listed in discovery. `private` communities are not listed, and
their members, announcements and games are visible to members only. The name is visible through
an invite link. A private community is indistinguishable from a missing one to a non-member,
following the same principle as `profile R4`.

**R5** — Team rosters: a `team` has a sport, and its roster is between the sport format's
`team_size` and **3× `team_size`**. A player may be on several teams. Roster changes while the team
is entered in a live league season are governed by `leagues R7`; the entry itself keeps its
registration snapshot (registration R19).

**R6** — Phase 2 has **announcements only**: no chat and no comments. Chat carries a moderation
cost this team cannot staff yet, and it is a Phase 3 conversation. Announcements fan out through
`notifications.emitBulk` with the `community.announcement` template (chunked per notifications R7),
limited to **3 per community per day**.

**R7** — Caps: **5,000 members** per community, and a user may **own at most 10** communities.
Both are config. They exist to stop spam communities, not to limit real clubs.

**R8** — Communities and announcements are reportable (`admin R6`). An auto-hidden announcement
disappears for members until reviewed.

**R9** — Communities hold **no money** in Phase 2. Paid memberships would be a new payment subject
(`payments R20`) and are a Phase 3 conversation.

---

## Schema

```sql
CREATE TABLE communities (
  id              uuid PRIMARY KEY,
  slug            text UNIQUE NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('club','group','team')),
  name            text NOT NULL,
  sport_id        uuid REFERENCES sports(id),
  city            text,
  geo             geography(Point,4326),
  description     text,
  logo_public_id  text,
  home_venue_id   uuid REFERENCES venues(id),
  join_policy     text NOT NULL DEFAULT 'approval'
                  CHECK (join_policy IN ('open','approval','invite_only')),
  visibility      text NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public','private')),
  member_count    integer NOT NULL DEFAULT 0,
  hidden_at       timestamptz,                    -- admin R6
  created_by      uuid NOT NULL REFERENCES player_profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'team' OR sport_id IS NOT NULL)  -- R5
);
CREATE INDEX communities_geo_idx ON communities USING gist (geo)
  WHERE visibility = 'public' AND hidden_at IS NULL;

CREATE TABLE community_members (
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES player_profiles(id),
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  is_captain      boolean NOT NULL DEFAULT false, -- teams only
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, player_id)
);
CREATE INDEX ON community_members (player_id);
-- R3: exactly one owner.
CREATE UNIQUE INDEX community_one_owner ON community_members (community_id) WHERE role = 'owner';

CREATE TABLE community_join_requests (
  id              uuid PRIMARY KEY,
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES player_profiles(id),
  kind            text NOT NULL CHECK (kind IN ('request','invite')),
  note            text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  expires_at      timestamptz NOT NULL,           -- +30 days (R2)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX community_one_pending
  ON community_join_requests (community_id, player_id) WHERE status = 'pending';

CREATE TABLE community_announcements (
  id              uuid PRIMARY KEY,
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  author_id       uuid NOT NULL REFERENCES player_profiles(id),
  title           text NOT NULL,
  body            text NOT NULL CHECK (char_length(body) <= 2000),
  hidden_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON community_announcements (community_id, created_at DESC);
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `COMMUNITY_NOT_FOUND` | user | Also for a private community to a non-member — R4 |
| `ALREADY_MEMBER` | user | Route to the community |
| `JOIN_REQUEST_PENDING` | user | Show the pending state |
| `INVITE_REQUIRED` | user | `invite_only` community |
| `OWNER_MUST_TRANSFER` | user | Offer ownership transfer — R3 |
| `ROSTER_FULL` | user | Team at 3× team size — R5 |
| `ANNOUNCEMENT_LIMIT` | user | R6 |
| `COMMUNITY_LIMIT` | user | R7 |

## Emits

| Event | Consumers |
|---|---|
| `community.updated` | discovery |
| `community.member_joined` | notifications, social (feed) |
| `community.join_requested` | notifications (admins) |
| `community.announcement` | notifications |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `expire-join-requests` | Daily | 3 × exp | Drop |

---

## Done when

A club with `approval` policy receives a request, an admin approves it, and the new member sees
private announcements that a non-member cannot distinguish from a missing community. An owner
cannot leave without transferring. A team's roster stops at 3× the format's team size. An
announcement reaches every member's feed, and the fourth one that day is refused.

---

## Implementation checklist

- [ ] Migration `017_communities.sql` including the one-owner and one-pending indexes
- [ ] Join policies and 30-day request expiry (R2)
- [ ] Ownership transfer; owner-leave guard (R3)
- [ ] Private visibility with null-fill, not errors (R4)
- [ ] Team roster bounds from `sport.formatsFor` (R5)
- [ ] Announcements via `emitBulk`, 3/day cap (R6)
- [ ] `community.announcement`, `community.invite`, `community.join_request` templates in notifications
- [ ] Tests naming R2, R3, R4, R5, R6, R7
