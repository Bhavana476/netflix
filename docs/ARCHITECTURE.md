# Architecture Overview (as built)

**Stack: Option B — MERN** (MongoDB + Express 4 + React 18 + Node.js/Socket.io 4), JavaScript only. **Track A — Full-Stack.**

```
┌──────────────────────────── React SPA (Vite) ─────────────────────────────┐
│ Login · Dashboard (history, rec rail, rooms, catalog, past sessions)      │
│ Watch Room: <video> + SyncController · subtitles · trivia · vote · chat   │
│            · AI co-pilot panel · people/moderation   ·   Admin uploads    │
└──────────────┬──────────────────────────────────┬────────────────────────┘
               │ REST /api/v1 (JWT)               │ Socket.io ns "/rooms" (JWT at handshake)
┌──────────────▼──────────────┐    ┌──────────────▼──────────────────────────┐
│ Express API (src/routes)    │    │ Real-time gateway (src/realtime)        │
│ auth · titles · watch-spaces│◄──►│ gateway.js: envelope routing, presence, │
│ me (recs/history) · admin   │    │   grace timers, trivia ticker (100 ms)  │
│ metrics middleware          │    │ roomState.js: pure state machine        │
└──────────────┬──────────────┘    └──────────────┬──────────────────────────┘
               │  plain service modules shared by both entry points
┌──────────────▼──────────────────────────────────▼──────────────────────────┐
│ AI Content Engine (src/ai)                 Recommender (src/recs)           │
│ timelineSchema: parse+validate (ingest)    recommender.js: hybrid CB + CF   │
│ retrieval: intent + BM25-lite + recency    service.js: batch train, rail    │
│ engine: grounded answer (LLM or extractive), trivia track, variations, subs │
└──────────────┬──────────────────────────────────────────────────────────────┘
┌──────────────▼──────────────────────────────────────────────────────────────┐
│ Persistence: MongoDB via one pooled Mongoose connection (maxPoolSize 20).    │
│ Event log written in batches (2 s or 20 events). Video: public CC sample     │
│ MP4s, or /media/*.mp4 served from server/media.                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Request paths

**Joining a room.** The client opens the socket with its JWT. It then sends 5 × `room.sync.ping` to estimate the clock offset and keeps the lowest-RTT sample. Next it sends `room.join`. The server checks membership, privacy, capacity, lock and removal. On the first join it loads the room into memory, caching the title and replaying the last 50 messages, and replies with a snapshot. The client seeks to `positionSeconds + (serverNow − serverTime)`.

**Keeping playback in sync.** The host's play, pause and seek become `room.playback.update` events. `RoomState.applyPlayback` checks that the sender is the current host and updates `{state, position, updatedAt, seq}`, and the new state is broadcast to everyone. The authoritative position is never stored per heartbeat. It is computed as `position + (now − updatedAt)·rate`. Each client sends `room.sync.report` once a second. `computeCorrection` compares the report with the authoritative clock at the client's own server-time timestamp, so network delay doesn't count as drift, and responds as follows:

| Drift | Action |
|---|---|
| ≤ 50 ms | none |
| < 1 s | `rate` nudge: `playbackRate = 1 − drift/2`, clamped to ±8%, for long enough to close the gap |
| ≥ 1 s | `seek` |

If the host's player buffers, the host sends `buffering`, which holds the clock for everyone until the host resumes.

**Asking the co-pilot (REST or socket).** `askAi` sanitizes the question and logs an `ai_question` event. `retrieveContext` scores only entries with `ts ≤ currentTs + 2 s`, so it can't spoil later events. Scoring combines intent detection (who / define / recap), IDF-weighted term overlap, recency, and an on-screen boost for character windows when the question points at someone ("who is that", "walked in"). Entries scoring below 75% of the best match are dropped.

`answerQuestion` then produces the answer. If `ANTHROPIC_API_KEY` is set, the LLM sees only the retrieved entries and must return JSON listing the entry IDs it used. The server keeps only IDs that were actually retrieved, and rejects any answer that cites none. Otherwise, or if the LLM times out after 2.5 s or fails, a deterministic extractive answerer writes sentences directly from the cited entries. If nothing relevant is retrieved, the co-pilot declines. The answer is broadcast as `room.ai.answer` with `sourceEvents`.

**Trivia.** A 100 ms ticker visits each playing room. `RoomState.dueTrivia` returns markers crossed since the last tick (each fires once per session; markers skipped by a seek don't fire), filtered by the host's verbosity setting. Each card carries its `lagMs`.

**Variations.** The ticker offers each upcoming variation point to the host 45 s ahead (`room.variation.suggested`). The host can open a timed vote or approve an option directly. `closeVote` picks the winner deterministically: most votes, with ties going to the authored default, then authored option order. The payload broadcast to every client is identical and includes `applyAtTs`, so each client applies the choice at the same point on the shared clock. Subtitle variations override one authored line. Scene variations show a pre-authored insert card between `ts` and `endTs`. Per-viewer locale subtitles come from `GET /titles/:id/subtitles?locale=`, and switching them never touches playback state.

**Presence and failover.** A user is keyed by userId and can have several sockets. When the last socket drops, the user shows as `reconnecting`. After `RECONNECT_GRACE_MS` (8 s) without a reconnect they are marked `left`; reconnecting within that window resumes the session without a duplicate join. If the host drops, see the deterministic policy in [API.md](API.md#host-disconnect-policy-deterministic).

**Ending a session.** The server flushes the event log, sets the status to `ended`, and **computes the summary from the event log itself**. That is why `GET /analytics` can report that the stored summary reconciles with the log. It also upserts one `Interaction` per participant (`watchedSeconds`, `completed`, `coWatchedWith`), and these feed the recommender.

## Data model (MongoDB, as shipped)

```mermaid
erDiagram
  USER ||--o{ REFRESH_TOKEN : has
  USER ||--o{ WATCH_SPACE : hosts
  USER }o--o{ WATCH_SPACE : "participantIds"
  TITLE ||--o{ WATCH_SPACE : "is watched in"
  TITLE ||--|{ TIMELINE_EVENT : "embeds (timeline[])"
  TITLE ||--o{ CHARACTER : "embeds (characters[])"
  TITLE ||--o{ SUBTITLE_LINE : "embeds (subtitles.lines[])"
  WATCH_SPACE ||--o{ SESSION_EVENT : logs
  USER ||--o{ SESSION_EVENT : authors
  USER ||--o{ INTERACTION : generates
  TITLE ||--o{ INTERACTION : "is rated/watched in"

  USER { ObjectId _id PK; string email UK; string displayName; string passwordHash; enum role "viewer|host|admin"; object preferences "subtitleLocale, genreAffinity[]"; bool synthetic }
  REFRESH_TOKEN { ObjectId _id PK; ObjectId userId FK; string tokenHash UK; date expiresAt "TTL index"; date revokedAt }
  TITLE { string _id PK "t_1001"; string name; int durationSeconds; string[] genres "indexed"; string[] tags; string videoAssetUrl; int timelineVersion; bool hasFullTimeline }
  TIMELINE_EVENT { string id; number ts; number endTs; enum type "trivia|character|glossary|scene|variation_point"; enum importance; string text; string characterId; string term; string definition; object variation "id, kind, targetLineId, prompt, defaultOptionId, options[]" }
  WATCH_SPACE { string _id PK "ws_…"; string titleId FK; ObjectId hostUserId FK "current host"; ObjectId createdBy FK; string inviteCode UK; enum status "scheduled|live|ended"; enum privacy; object settings; ObjectId[] participantIds; date scheduledFor; date startedAt; date endedAt; object[] appliedVariations; object summary }
  SESSION_EVENT { ObjectId _id PK; string msgId UK; string watchSpaceId FK; ObjectId userId FK "null for AI/system"; enum type "chat|ai_question|ai_answer|trivia|system|join|leave|reaction|vote|variation_applied"; string body; mixed meta; number tsSeconds; date createdAt }
  INTERACTION { ObjectId _id PK; ObjectId userId FK; string titleId FK; number watchedSeconds; bool completed; int rating "1-5"; ObjectId[] coWatchedWith; enum source "synthetic|live|rating"; string watchSpaceId }
```

Indexes: `users.email` (unique), `refresh_tokens.tokenHash` (unique) plus a TTL on `expiresAt`, `watch_spaces.inviteCode` (unique), `watch_spaces.status`, `watch_spaces.hostUserId`, `watch_spaces.participantIds`, `session_events.(watchSpaceId, createdAt)`, `session_events.msgId` (unique, which makes batched inserts idempotent), and `interactions.(userId, titleId)`. The batch-trained model is a single document, `recmodels._id = "current"`.

### Relational vs. document trade-off (PRD learning outcome)
The timeline is **embedded** in the Title document, as Section 9.2 recommends. A title's timeline is small (tens to hundreds of events), written rarely (on admin upload) and read as a whole by the AI engine. The engine caches it in memory per title and range-queries it with a binary search over the `ts`-sorted array (`eventsInRange`). That works here only because the array is small and kept sorted on ingest. The PostgreSQL design in Section 7.2.2 normalizes `timeline_events` with a B-tree index on `(title_id, ts_seconds)`, which wins when timelines are large, edited event by event, or queried across titles (for example "all trivia mentioning X"). We would switch to that layout, or to a separate `timeline_events` collection indexed on `{titleId, ts}`, if timelines grew past the 16 MB document limit or needed per-event editing.

## Real-time load and DB policies (Section 9.4)
- Playback heartbeats and drift reports are **never written to the DB**. Playback position lives in memory, and only coarse data is persisted: `lastPositionSeconds` when a room unloads, plus the summary.
- Chat and session events are written in batches (`CHAT_FLUSH_MS=2000` or `CHAT_FLUSH_COUNT=20`). Recent history is served from an in-memory ring of 50 messages, so a reconnecting client never waits for a flush.
- Nothing assumes a single room. `rooms` is a `Map<watchSpaceId, RoomContext>`, each room uses its own Socket.io room, and timers are scoped to each room.
- The gateway and the AI engine are separate modules. The engine has no socket code and is unit-tested on its own.
- **Scaling beyond one process** (not built): add `@socket.io/redis-adapter` for fan-out, and either move `RoomState` into Redis or pin each room to one node with sticky sessions keyed by `watchSpaceId`.

## Security
- Access JWTs (HS256) last 15 minutes. Refresh tokens are opaque 256-bit values; only their SHA-256 hash is stored, each use rotates them, and a replayed token is rejected.
- RBAC is enforced on the server through `requireRole` on routes and through `RoomState` checks for socket events (the current host only). A viewer can't self-register as admin.
- The WebSocket handshake verifies the JWT. Host-sensitive socket events are refused once the token expires, and `session.reauth` lets the client swap in a fresh token.
- Input validation: chat, questions and display names have HTML tags and angle brackets stripped, control characters removed and lengths capped. Timeline uploads reject `<` and `>`. The React client renders everything as text and never uses `dangerouslySetInnerHTML`. Helmet sets security headers, and the JSON body limit is 2 MB.
- Secrets come only from environment variables. `.env` is gitignored. The server refuses to start without a `JWT_SECRET` of at least 32 characters. Seed passwords come from env vars or are randomly generated and printed once.

## Observability
- JSON-lines logs. Every room event and every co-pilot request/response is logged with `correlationId = <watchSpaceId>:<session start>`, and sensitive keys are redacted. Question text and chat bodies are not logged; message length and IDs are. High-frequency `room.sync.*` traffic is excluded from per-event logs and is recorded as metrics instead.
- `GET /api/v1/admin/metrics` reports p50/p95/p99/max for `http.api`, `http.ai`, each route, `ai.answer`, `sync.drift.abs`, `sync.correction.*` and `trivia.lag`.
- Health endpoints: `/health` (checks the DB) and `/health/realtime`.

## Deviations from the PRD (and why)
| PRD | As built | Reason |
|---|---|---|
| "Authoritative playback state machine owned by the Host's client" | The host's client **issues** the transitions; the **server** holds the authoritative clock | A server clock lets late joiners, drift correction and host failover work while the host is offline. Only the current host can change it |
| `chat_messages` collection | `sessionevents` collection with a `type` discriminator (the alternative the PRD itself offers) | One ordered log drives chat history, analytics and reconciliation |
| "Every WebSocket room event logged" | Every room event except `room.sync.ping/report`, which become metrics | These run once per second per client; logging them would flood the logs |
| `room.sync.ping/pong` events | Ping is an acknowledged request whose ack carries the pong `{clientSentAt, serverReceivedAt}` | Same data, and no event correlation needed |
| Real video variation inserts | Scene variations show a pre-authored on-screen insert card | No video re-authoring tools in scope (PRD 4.2). The mechanism (timed, voted, identical across clients) is the same |
| Drift correction threshold | 50 ms (configurable with `DRIFT_THRESHOLD_MS`) | At 100 ms, P95 drift measured 140 ms; at 50 ms it measured 98 ms (see TESTING.md) |
