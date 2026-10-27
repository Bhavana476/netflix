# API Reference

Base URL: `http://localhost:4000` (the Vite dev server on `:5173` proxies `/api`, `/socket.io`, `/media`, `/health`).
All REST bodies are JSON. Authenticated routes need `Authorization: Bearer <accessToken>`.

**Errors** always look like this:

```json
{ "error": { "code": "FORBIDDEN", "message": "Requires role: admin" } }
```

| Status | Typical `code` values |
|---|---|
| 400 | `BAD_REQUEST`, `BAD_JSON` |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH` |
| 403 | `FORBIDDEN` (wrong role / not a member), `NOT_HOST` |
| 404 | `NOT_FOUND` |
| 409 | `EMAIL_TAKEN`, `ROOM_FULL`, `ALREADY_ENDED` |
| 410 | `ENDED` |
| 422 | timeline validation failure. The body is `{ valid:false, errors:[{path,message}] }` |

Roles: `viewer` (join rooms), `host` (also create rooms), `admin` (also content management, metrics, retraining). Inside a room, *host* means the **current room host** (`hostUserId`), which can change through transfer or failover. Every permission is checked on the server.

A ready-made Postman collection is in [`postman_collection.json`](postman_collection.json).

---

## Health

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `200 {"status":"ok","db":"up","uptimeSec":42}` or `503` when the DB is down |
| GET | `/health/realtime` | none | `200 {"status":"ok","rooms":1,"sockets":3}` |

## Auth: `/api/v1/auth`

### POST `/register`
```json
// request
{ "email": "sam@example.com", "password": "at-least-8", "displayName": "Sam", "role": "host" }
// 201
{ "user": { "id": "6718…", "email": "sam@example.com", "displayName": "Sam", "role": "host",
            "preferences": { "subtitleLocale": "en", "genreAffinity": [] } },
  "accessToken": "<JWT, 15 min>", "refreshToken": "<opaque>", "expiresIn": 900 }
```
`role` may be `viewer` (default) or `host`. A request for `admin` silently becomes `viewer`. Admins are created by the seed script or promoted by an existing admin.

### POST `/login`
`{ "email", "password" }` → same shape as register (`200`). Wrong credentials → `401 INVALID_CREDENTIALS`.

### POST `/refresh`
`{ "refreshToken" }` → `200` with a **new** access token and a **new** refresh token. The old refresh token is revoked, so replaying it returns `401 INVALID_REFRESH`.

### POST `/logout`
`{ "refreshToken" }` → `204`. Revokes the refresh token.

### GET `/me` (auth)
`200 { "user": { … } }`

### POST `/host-code` (auth)
`{ "code": "HOST-XXXXXX" }` → `200` with `{ user, accessToken, refreshToken }`. A viewer whose code matches the server's `HOST_ACCESS_CODE` is promoted to **host**, and the new access token carries that role. Hosts and admins keep their role. Errors: `403 INVALID_HOST_CODE`, `429 TOO_MANY_ATTEMPTS` (5 wrong codes per user per 15 min), `503 HOST_CODE_DISABLED` when no code is configured.

### PATCH `/me/preferences` (auth)
`{ "subtitleLocale": "es", "genreAffinity": ["Sci-Fi"] }` → `200 { "user": { … } }`. The locale must match `xx` or `xx-YY`.

## Titles: `/api/v1/titles` (auth)

### GET `/`
Optional `?genre=Animation`. Returns `200 { "titles": [ { "id":"t_1001", "name", "synopsis", "year", "durationSeconds", "genres", "tags", "posterColor", "hasFullTimeline", "videoAssetUrl" } ] }`

### GET `/:titleId`
Title details plus `characters`, `timelineVersion` and `eventCount`.

### GET `/:titleId/timeline?from={sec}&to={sec}` (mandatory endpoint 7.3.2)
```json
{
  "titleId": "t_1001", "timelineVersion": 1, "from": 140, "to": 240,
  "events": [
    { "id": "evt_bbb_009", "ts": 150, "endTs": 560, "type": "character", "characterId": "c_frank", "text": "Frank watches Bunny from a branch." },
    { "id": "evt_bbb_012", "ts": 170, "type": "scene", "title": "The bullies strike", "text": "…" },
    { "id": "evt_bbb_013", "ts": 200, "type": "glossary", "term": "Flying squirrel", "definition": "…" },
    { "id": "evt_bbb_014", "ts": 228, "endTs": 236, "type": "variationPoint", "variationId": "v_bbb_01", "kind": "subtitle",
      "prompt": "How should Bunny's sigh be captioned?",
      "options": [ { "id": "a", "label": "Original" }, { "id": "b", "label": "Exasperated" }, { "id": "c", "label": "Disappointed parent" } ] }
  ]
}
```
`from`/`to` default to the whole title. `400` if they aren't numbers or `from > to`.

### GET `/:titleId/subtitles?locale=es`
Returns the subtitle track for that locale. Where an authored alternate exists it replaces the default line.
```json
{ "titleId": "t_1001", "version": 1, "locale": "es", "availableLocales": ["en","es","fr","hi"],
  "lines": [ { "id": "sub_bbb_05", "start": 230, "end": 236, "text": "[El conejo suspira] Otra vez no...", "source": "locale:es" } ] }
```

## Watch Spaces: `/api/v1/watch-spaces` (auth)

### POST `/` (host or admin) (mandatory endpoint 7.3.1)
```json
// request
{ "titleId": "t_1001", "maxParticipants": 25, "aiVerbosity": "normal", "votingEnabled": true,
  "name": "Friday night", "privacy": "invite", "triviaEnabled": true, "scheduledFor": "2026-11-01T19:00:00Z" }
// 201
{ "watchSpaceId": "ws_2f9c0a1b3d", "inviteCode": "NX-4Q7K", "status": "scheduled", "hostUserId": "6718…",
  "createdAt": "2026-10-23T10:15:00.000Z", "name": "Friday night", "titleId": "t_1001", "privacy": "invite",
  "settings": { "maxParticipants": 25, "aiVerbosity": "normal", "votingEnabled": true, "triviaEnabled": true }, … }
```
Only `titleId` is required. `maxParticipants` is 2–50, `aiVerbosity` is `minimal|normal|chatty`, and `privacy` is `invite|public`. A viewer gets `403`.

### GET `/?status=live,scheduled`
The rooms you host or have joined, for the dashboard: `{ "watchSpaces": [ { …, "titleName", "isHost" } ] }`.

### POST `/join`
`{ "inviteCode": "NX-4Q7K" }` → `200 { "watchSpaceId", "titleId", "name", "status" }`. Adds you as a member. Other outcomes: `404` unknown code, `410` ended, `409 ROOM_FULL`.

### GET `/:id`
Room details. For an invite-only room you must be a member (`403` otherwise).

### GET `/:id/messages?limit=50` (member)
Persisted chat, AI answers and system messages, oldest first:
`{ "messages": [ { "messageId", "type": "chat|ai_answer|system", "userId", "displayName", "body", "tsSeconds", "sourceEvents", "createdAt" } ] }`

### POST `/:id/ai/ask` (member) (mandatory endpoint 7.3.3)
```json
// request (userId is accepted for compatibility; the server uses the token's user)
{ "userId": "u_733", "currentTs": 152, "question": "Who is the character that just walked in?" }
// 200
{
  "questionId": "q_6c1e0b4a7f",
  "answer": "That's Frank — the leader of the three rodent bullies, a flying squirrel who can glide between trees (on screen from 00:02:30).",
  "sourceEvents": ["evt_bbb_009"],
  "sources": [ { "id": "evt_bbb_009", "type": "character", "ts": 150, "label": "Frank" } ],
  "explanation": "Drawn from character entry evt_bbb_009 @ 00:02:30.",
  "grounded": true, "model": "extractive", "latencyMs": 3,
  "generatedAt": "2026-10-23T14:05:11.020Z"
}
```
If no timeline entry up to `currentTs` matches, the co-pilot **declines** with `grounded:false` and `sourceEvents:[]`. The answer is also broadcast to the room as `room.ai.answer`. If `currentTs` is omitted, the room's authoritative position is used.

### POST `/:id/end` (current room host or admin)
→ `200 { "watchSpaceId", "status": "ended", "summary": { "durationSeconds", "peakParticipants", "aiQuestions", "triviaSurfaced", "chatMessages", "reactions" } }`

### GET `/:id/analytics` (member)
Returns the stored summary next to a recount from the raw event log:
```json
{ "watchSpaceId": "ws_…", "status": "ended",
  "summary": { "durationSeconds": 34, "peakParticipants": 3, "aiQuestions": 5, "triviaSurfaced": 15, "chatMessages": 2, "reactions": 1 },
  "fromEventLog": { …same keys…, "eventCounts": { "chat": 2, "join": 3, … }, "totalEvents": 41 },
  "reconciles": true }
```

## Personal: `/api/v1/me` (auth)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/recommendations?k=10` | | `{ modelTrainedAt, basedOnInteractions, items: [ { titleId, score, cf, cb, reason, title: {…} } ] }` |
| POST | `/interactions` | `{ titleId, rating?: 1-5, watchedSeconds?, completed? }` | `201 { interaction }`. Upserts your rating for the title |
| GET | `/history` | | `{ history: [ { titleId, name, progress, completed, rating, lastWatchedAt, … } ] }` |
| GET | `/sessions` | | Ended Watch Spaces you hosted or joined, with summaries |

## Admin: `/api/v1/admin` (admin only; anyone else gets `403`)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/timelines/validate` | `{ content: "<yaml or json text>", format: "auto\|yaml\|json" }` or `{ timeline: {…} }` | `200 { valid:true, errors:[], summary }` or `422 { valid:false, errors:[{path,message}] }` |
| POST | `/timelines` | same | `201 { valid:true, titleId, timelineVersion, eventCount }` or `422` |
| DELETE | `/titles/:titleId` | | `204` |
| POST | `/recommendations/retrain` | | `{ trainedAt, interactionCount, items, users, trainMs }` |
| GET | `/metrics` | | `{ metrics: { "http.api": {count,p50,p95,p99,max}, "ai.answer": …, "sync.drift.abs": …, "trivia.lag": … }, realtime, uptimeSec }` |
| GET | `/users` | | `{ users: [...] }` |
| PATCH | `/users/:userId/role` | `{ role }` | `{ user }` |

---

# WebSocket protocol

Connect with Socket.io to the **`/rooms` namespace**, passing the JWT at handshake:

```js
const socket = io('http://localhost:4000/rooms', { auth: { token: accessToken }, transports: ['websocket'] });
```

An invalid or missing token fails the handshake with `connect_error` and message `UNAUTHENTICATED`.

All traffic goes over a single event channel named **`message`**, using one envelope shape in both directions:

```json
{ "event": "room.chat.message", "watchSpaceId": "ws_2f9c0a1b3d", "payload": { "body": "hi" }, "ts": 1761228000123 }
```

Client→server messages should pass a Socket.io acknowledgement callback. The ack is `{ ok: true, ...result }` or `{ ok: false, error: { code, message, event } }`. If no ack callback is given, errors arrive as a `room.error` event instead. For server→client events, `ts` is the server send time in epoch milliseconds.

Host-only events (marked **H**) are re-checked against the **current room host** every time. They are also refused with `TOKEN_EXPIRED` once the socket's access token has expired; the client fixes this by sending `session.reauth`.

## Client → server

| Event | Payload | Ack result | Notes |
|---|---|---|---|
| `room.join` | – | `{ room: Snapshot, isNew }` | Must be sent first. Invite-only rooms need prior membership (`POST /join`). Rejoining within the grace window gives `isNew:false` and no duplicate `joined` broadcast. Errors: `FORBIDDEN`, `ROOM_FULL`, `LOCKED`, `REMOVED`, `ENDED`, `NOT_FOUND` |
| `room.leave` | – | `{}` | Leave immediately (no grace period) |
| `room.sync.ping` | `{ clientSentAt }` | `{ clientSentAt, serverReceivedAt }` | Allowed before `room.join`. Used to estimate the clock offset (NTP-style; keep the lowest-RTT sample) |
| `room.sync.report` | `{ positionSeconds, serverTimeEstimate, rttMs?, buffering? }` | `{ correction, playback }` | Send about once per second. `correction` is `{action:'none'}`, `{action:'rate', rate, durationMs, driftMs}` (set `playbackRate` for `durationMs`, then back to 1) or `{action:'seek', targetPosition, driftMs}` |
| `room.playback.update` **H** | `{ state: 'play'\|'pause'\|'seek'\|'buffering', positionSeconds? }` | `{ playback }` | Broadcast to everyone as `room.playback.update` |
| `room.chat.message` | `{ body }` (≤500 chars, sanitized) | `{ messageId }` | `MUTED` if the host muted you |
| `room.chat.typing` | `{ isTyping }` | `{}` | Sent to everyone else in the room |
| `room.chat.reaction` | `{ emoji }`, one of 👍 😂 😮 😢 ❤️ 🔥 👏 | `{}` | |
| `room.ai.ask` | `{ question, currentTs? }` | `{ questionId }` | Answer arrives as `room.ai.answer` |
| `room.ai.pin` **H** | `{ text, sourceEventId? }` | `{}` | |
| `room.ai.triviaRound` **H** | – | `{ eventId }` | Surfaces the latest unfired trivia entry at or before the playhead |
| `room.settings.update` **H** | `{ triviaEnabled?, votingEnabled?, aiVerbosity? }` | `{ settings }` | |
| `room.variation.openVote` **H** | `{ variationId, durationSec? (5-120, default 20) }` | `{ variationId, prompt, kind, options, closesAt, applyAtTs }` | Errors: `VOTING_DISABLED`, `VOTE_ACTIVE`, `ALREADY_APPLIED` |
| `room.variation.vote` | `{ variationId, optionId }` | `{ variationId, counts, totalVotes }` | One vote per user; you may change it |
| `room.variation.closeVote` **H** | – | applied result | Closes the vote early |
| `room.variation.apply` **H** | `{ variationId, optionId }` | applied result | Host applies a pre-authored option directly |
| `room.mod.mute` / `room.mod.unmute` **H** | `{ userId }` | `{}` | |
| `room.mod.remove` **H** | `{ userId }` | `{}` | The removed user gets `room.removed` and cannot rejoin this session |
| `room.mod.lock` / `room.mod.unlock` **H** | – | `{}` | A locked room refuses new joins; reconnects are still allowed |
| `room.mod.transferHost` **H** | `{ userId }` | `{}` | Target must be connected |
| `room.end` **H** | – | `{ summary }` | |
| `session.reauth` | `{ accessToken }` | `{}` | Swaps in a refreshed token without reconnecting |

**Snapshot** (in the `room.join` ack):
```json
{ "watchSpaceId": "ws_…", "hostUserId": "…", "hostDisconnected": false, "locked": false,
  "settings": { "maxParticipants": 25, "aiVerbosity": "normal", "votingEnabled": true, "triviaEnabled": true },
  "playback": { "state": "playing", "positionSeconds": 151.2, "serverTime": 1761228000123, "rate": 1, "seq": 7, "issuedBy": "…", "lastAction": "play" },
  "participants": [ { "userId", "displayName", "isHost", "connected", "muted", "joinedAt", "quality": "good|fair|poor|unknown", "rttMs" } ],
  "history": [ { "kind": "chat", "messageId", "userId", "displayName", "body", "tsSeconds", "createdAt" },
               { "kind": "ai_answer", "messageId", "question", "answer", "sourceEvents", "sources", "tsSeconds" } ],
  "appliedVariations": { "v_bbb_01": "c" },
  "variations": [ { "id", "kind", "prompt", "ts", "endTs", "targetLineId", "defaultOptionId", "options": [ { "id", "label", "text" } ] } ],
  "vote": null,
  "title": { "id": "t_1001", "name": "Big Buck Bunny", "videoAssetUrl": "…", "durationSeconds": 596 },
  "you": { "userId": "…", "isHost": true } }
```
To compute the current position: `positionSeconds + (serverNow − serverTime)/1000` while `state === 'playing'`, where `serverNow = Date.now() + clockOffset`.

## Server → client

| Event | Payload |
|---|---|
| `room.playback.update` | `{ state: 'playing'\|'paused'\|'buffering', positionSeconds, serverTime, rate, seq, issuedBy, lastAction: 'play'\|'pause'\|'seek'\|'buffering'\|'host_disconnected' }` |
| `room.presence.update` | `{ participantId, action: 'joined'\|'left'\|'reconnecting'\|'resumed'\|'muted'\|'unmuted'\|'quality'\|'host', participantCount, participants: [...] }` |
| `room.chat.message` | `{ kind:'chat', messageId, userId, displayName, body, tsSeconds, createdAt }` |
| `room.chat.typing` | `{ userId, displayName, isTyping }` |
| `room.chat.reaction` | `{ userId, displayName, emoji }` |
| `room.ai.thinking` | `{ userId, displayName, question }` |
| `room.ai.answer` | `{ questionId, userId, displayName, question, answer, sourceEvents, sources, explanation, grounded, model, latencyMs, tsSeconds, generatedAt }` |
| `room.ai.trivia` | `{ eventId, type, tsSeconds, text, lagMs, onDemand? }` |
| `room.ai.pinned` | `{ text, sourceEventId, pinnedBy }` |
| `room.variation.suggested` | `{ variationId, kind, prompt, ts, options, defaultOptionId }`. Sent when a variation point is coming up within 45 s of the playhead |
| `room.variation.voteOpen` | `{ variationId, prompt, kind, options, closesAt, applyAtTs }` |
| `room.variation.voteTally` | `{ variationId, counts, totalVotes }` |
| `room.variation.applied` | `{ variationId, winningOptionId, counts?, totalVotes?, applyAtTs, via: 'vote'\|'host', kind, targetLineId?, endTs, option: { id, label, text } }`. All clients receive an identical payload, and it takes effect at `applyAtTs` on the shared playback clock |
| `room.settings.update` | `{ settings }` |
| `room.lock.update` | `{ locked }` |
| `room.host.disconnected` | `{ hostUserId, graceMs, policy: 'pause_then_promote' }` |
| `room.host.reconnected` | `{ hostUserId }` |
| `room.host.changed` | `{ hostUserId, previousHostUserId, reason: 'host_disconnected'\|'transfer' }` |
| `room.removed` | `{ by }` |
| `room.ended` | `{ summary, endedBy }` |
| `room.error` | `{ code, message, event }` (only when the request had no ack callback) |

## Host-disconnect policy (deterministic)
1. The host's last socket drops, so playback is **paused for everyone** at the current position. The server broadcasts `room.playback.update` (`lastAction: host_disconnected`) and `room.host.disconnected`.
2. If the host reconnects within `HOST_GRACE_MS` (default 10 s), they keep the role (`room.host.reconnected`). Playback stays paused until they resume it.
3. Otherwise the **connected participant who joined earliest** (ties broken by userId) becomes host (`room.host.changed`). If nobody is connected, the room stays paused.

If the host leaves on purpose (`room.leave`), step 3 happens immediately.
