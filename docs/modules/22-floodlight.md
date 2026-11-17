# 22 — Floodlight: pro, predictions, content (migration 059)

Built 2026-11-14 for the Floodlight redesign
(`PLAY_FRONTEND/docs/design/redesign-a-floodlight.md`). Founder decisions:
pro match data is entered by PL4Y staff (no feed yet); shorts play in a web
view (no native player); prediction points are separate from Rewards and
never redeemable.

## pro — `src/modules/pro`

Tables: `pro_teams`, `pro_matches`, `pro_match_moments`, `pro_match_messages`, `pro_team_fans`.

| Rule | |
|---|---|
| R1 | Scores are text (`182/4`, `2`, `21-17`). Nothing does arithmetic on them. |
| R2 | `stats`, `current_over`, `scorecard` are JSON with a Zod-checked shape; a bad shape is refused. |
| R3 | The board: live (and break) first, then upcoming soonest (14 days), then results (3 days). A fixture 12 h past its start that never went live is hidden. A feed match stuck at live stops being polled 6 days after its start. |
| R4 | One public chat room per match; signed-in players; 500 chars; 6 per 30 s; closed when staff close it or the match is abandoned. A hidden message keeps its body for staff. |
| R5 | Every change publishes on `private-pro-match-{id}` (`pro.match.updated`, `pro.chat.message`, `pro.chat.hidden`). |
| R6 | Favourite teams, up to 10. A match going live notifies fans of either team (`pro.match_live`). |
| R7 | A match with a settled question cannot be deleted (its points would outlive its picks): mark it abandoned. |

Adapter seam: `pro.updateMatch(id, patch)` is what a data feed will call; it
writes `provider` / `provider_ref` on create.

## predictions — `src/modules/predictions`

Tables: `prediction_questions`, `prediction_options`, `prediction_picks`, `prediction_points`.

| Rule | |
|---|---|
| R1 | Free to play. No entry fee, no buying points, no cash prizes, never redeemed. Nothing here touches payments or rewards. |
| R2 | One pick per player per question, changeable until `locks_at`. A pick takes `FOR SHARE` on the question, so none lands after a settle. |
| R3 | Settling marks every pick and writes points once, in one transaction under `FOR UPDATE`. Exact score: all points; right result, wrong score: a third (rounded down), not "correct". The push says "Right result · +N pts". |
| R4 | Void: no points, never counts for streaks or accuracy. |
| R5 | Points are rows in `prediction_points`, unique on (user, reason, ref). |
| R6 | Daily challenge (IST day): 3 picks, a live question, an exact score → +50 once. |
| R7 | Leaderboards: global, friends (active chats), sport, community (one or all of yours), city. Ties share a rank. |

## content — `src/modules/content`

Table: `content_items` (story | short | explainer | original).

| Rule | |
|---|---|
| R1 | Players see `published` only, newest first. |
| R2 | A short needs an https `video_url` to publish. |
| R3 | `published_at` is stamped the first time; archive hides without deleting. |
| R4 | Home shelf: hero original (featured first), 8 shorts, 6 stories, latest explainer. |

## Also in 059

- **communities** — posts gain `kind` (text, photo, video, poll, event), photos under
  `pl4y/communities/{id}/posts`, polls (`community_poll_options/votes`, changeable vote),
  club events with RSVPs (`community_post_rsvps`). New: `myCommunityPosts`, `myClubEvents`.
- **events** — `experience_kind` (screening, meetup, fitness, original) and `by_pl4y`,
  set by staff (`adminSetEventExperience`). Auto-draw skips experiences. `EventFilter.experience`.
- **profile** — R20 self-declared `athlete_label`; R21 `profile_records` ("added by you", max 20).
- **notifications** — `category` and `tag` on every row; `notifications(category:)` filter;
  routes `PRO_MATCH`, `PREDICTIONS` (and the missing `PARTNER_INVITE`, `MY_BOOKINGS` in the enum).
- **games** — `declineGameInvite`.

Tests: `tests/floodlight.test.ts`. Sample data: `pnpm seed:floodlight` (local only).

## Live data feeds (migration 060)

Plan: `PLAY_FRONTEND/docs/design/floodlight-data-sources.md`. Built 2026-11-15: G1–G6 and G8–G10.
G7 (sport rows for F1, NFL, baseball, ice hockey, rugby) is not built: the feeds cover sports PL4Y hosts.

| Rule | |
|---|---|
| feeds R1 | The app never calls a provider. The worker fetches once for everyone; keys stay on the server (`platform/config.ts`, worker service). |
| feeds R2 | G10 — every call is counted against the provider's daily limit (IST day, `pro_feed_providers`) before it is made. Live polls keep a reserve of 10–20 calls for fixtures. At the cap nothing is called; staff enter by hand. |
| feeds R3 | A failed call is recorded on the provider (`last_error`, portal `/pro/feeds`), never thrown into a request. Keys are scrubbed from messages. |
| feeds R4 | Only live, on-break, or due-within-15-minutes matches are polled, each provider at most every `pollMinutes` (CricAPI 5, API-Football 3, snooker.org 5). |
| feeds R5 | A poll sends only what changed; a quiet poll just stamps `feed_checked_at` (G9 "Updated N min ago" = `scoreCheckedAt`). |
| feeds R6 | A fixtures import creates matches and moves a still-scheduled one (new time, postponed, called off). It never touches a match under way: schedule lists are staler than live polls (CricAPI's has no scores). |
| pro R8 | Staff win. A field staff change by hand on a feed match is added to `feed_locked`; the feed skips it until staff give it back (`adminReleaseProMatchFeed`). The live desk sends only fields changed since editing began. |
| pro R9 | A match that finishes (or whose result changes) asks predictions for suggestions; one that is abandoned voids its open questions. |
| predictions R8 | Options can carry `outcome` (home/draw/away; choice questions on a match only, one each). On finish the result suggests the answer (`suggested_*`): exact score from whole-number scores, winner from `pro_matches.winner` or the score. Staff confirm ("Settle as suggested", audited). Nothing settles on its own. |
| predictions R9 | Abandoned → open questions void. |
| content R5 | `link` items: headline, publisher, address, picture. No body (DB check). Imported links de-duplicate on `source_url`, are published at once, sit in Home "Trending" with PL4Y stories, open at their source in the app's `/read` web view, and are archived after 14 days. A link with no picture gets a generic sport photo (Unsplash, else Pexels) with photographer credit, never a real player or team. |

Code: `src/platform/feeds.ts` (budget + HTTP), `src/modules/pro/feeds/` (types, `cricapi.ts`, `apiFootball.ts`, `snooker.ts`, `runner.ts`), `src/modules/content/feeds/news.ts`.
Worker queue `feeds`: `feeds-live` every minute, `feeds-fixtures` 06:00 + 18:00 IST, `feeds-news` every 2 h.
Follows (`pro_feed_follows`): CricAPI series id · API-Football league id + season · snooker.org event id · Google News / NewsData search. Managed in the portal at `/pro/feeds`, which also shows today's calls and runs a job now.
Env (worker): `CRICAPI_KEY`, `API_SPORTS_KEY`, `SNOOKER_API_ID`, `NEWSDATA_KEY`, `NEWS_RSS_ENABLED`, `UNSPLASH_KEY`, `PEXELS_KEY`, and `*_DAILY_LIMIT` for each.

Unverified against live providers (no keys yet): CricAPI and API-Football response field names are from their v1/v3 formats as known, not checked against a live response; snooker.org player and round fields likewise. Parsers are defensive (a missing field leaves a match as it is) and every shape goes through pro R2's checks. Check each provider's commercial terms before switching it on (data-sources §9).

Tests: `tests/floodlightFeeds.test.ts`. Local e2e data without keys: `pnpm seed:feeds-e2e` (plays the providers with canned responses; refuses production).
