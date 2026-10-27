# Watch Spaces: AI-Driven Social Watch Spaces

Synchronized group viewing rooms with a retrieval-grounded AI co-pilot, timeline-triggered trivia, pre-approved subtitle and narrative variations with group voting, and a hybrid recommendation engine. Built against the *AI-Driven Hyper-Personalized Interactive Content & Social Watch Spaces* PRD.

- **Stack:** Option B, **MERN** (MongoDB, Express, React, Node.js/Socket.io), all in JavaScript.
- **Track:** A, **Full-Stack** (React client included).

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | What was built, request flows, ER diagram, security, deviations from the PRD |
| [docs/API.md](docs/API.md) | Every REST endpoint and WebSocket event, with example payloads |
| [docs/TIMELINE_SCHEMA.md](docs/TIMELINE_SCHEMA.md) | The authoring format the admin upload validates against |
| [docs/TESTING.md](docs/TESTING.md) | Test suite, measured performance against PRD targets, evidence index |
| [docs/RETROSPECTIVE.md](docs/RETROSPECTIVE.md) | What was built, what was descoped, what's next |
| [docs/postman_collection.json](docs/postman_collection.json) | Postman collection for the whole API |

## Quick start (no database install needed)

Prerequisites: **Node.js 20+** (tested on 24.15). MongoDB is optional; see below.

```bash
npm install                     # installs server + client workspaces (also fetches a mongod binary for the embedded DB)
cp .env.example .env            # Windows: copy .env.example .env
```

Edit `.env` and set at least:

```bash
JWT_SECRET=<output of: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
SEED_ADMIN_PASSWORD=<choose one>
SEED_HOST_PASSWORD=<choose one>
SEED_VIEWER_PASSWORD=<choose one>
```

Then run it:

```bash
npm run dev       # API + gateway on :4000, React dev server on :5173 -> open http://localhost:5173
# or, production-style on one port:
npm run build && npm start      # open http://localhost:4000
```

On first boot with an empty database the server **seeds itself**. It creates 30 titles (3 with fully authored AI timelines), the demo accounts below, and a synthetic interaction dataset of 60 users / 680 interactions, then trains the recommender.

| Account | Role | Password |
|---|---|---|
| `admin@watchspaces.local` | admin | `SEED_ADMIN_PASSWORD` |
| `host@watchspaces.local` | host | `SEED_HOST_PASSWORD` |
| `viewer@watchspaces.local` | viewer (subtitle locale `es`) | `SEED_VIEWER_PASSWORD` |
| `viewer2@watchspaces.local` | viewer | `SEED_VIEWER_PASSWORD` |

If a `SEED_*` variable is empty, the seed script generates a random password and prints it to the console once.

### Database options
- **Embedded (default):** with `MONGO_URI` empty, the server starts a real `mongod` through `mongodb-memory-server` and persists it to `.data/db`. Delete `.data/` to reset. Stop the server before running `npm run seed`, because the embedded DB holds a file lock.
- **Your own MongoDB:** set `MONGO_URI=mongodb://localhost:27017/watch_spaces` and `USE_MEMORY_DB=false`.
- **Docker:** `docker compose up --build`, then open http://localhost:4000. This uses MongoDB 7 plus the app image. *Note: the Dockerfile and compose file are provided but were not run on the build machine, which had no Docker.*

### Video
Titles stream the Creative Commons Blender open movies (Big Buck Bunny, Sintel, Tears of Steel, Elephants Dream) from `archive.org`; placeholder catalog titles reuse these films. (The Google sample bucket used originally now returns 403.), so the browser needs internet access. To run fully offline, put `.mp4` files in `server/media/` and set `videoAssetUrl: /media/<file>.mp4` in a timeline upload.

### Optional: hosted LLM for the co-pilot
Set `ANTHROPIC_API_KEY` (model `AI_MODEL`, default `claude-haiku-5-5`). The model only sees the retrieved timeline entries and must return the IDs of the entries it used; the server drops any ID it didn't retrieve. Without a key, or if the call fails or takes longer than `AI_TIMEOUT_MS`, a deterministic **extractive** answerer builds the answer directly from the cited entries. Both modes return the same payload. The extractive mode is the default because it is fully verifiable and needs no account.

## Demo walkthrough (two browser sessions)

1. Window A: sign in as **host@**. Window B (a private window or another browser): sign in as **viewer@**.
2. In A, click **Big Buck Bunny** in the catalog, then **Create & enter**. Copy the invite link from the room header.
3. In B, paste the invite link, or enter the code in **Join** on the dashboard. B joins and syncs to A's position. Click "Click to join playback" if the browser blocks autoplay.
4. In A, press **Play**, then seek to around **2:20**. B follows. The header shows live drift and RTT, and drift stays under 100 ms in steady state.
5. Around **2:30**, in B's **AI Co-Pilot** tab, ask *"Who is the character that just walked in?"*. The answer is Frank, with a source chip `character · Frank @ 2:30`. Then ask *"Who won the World Cup?"*; the co-pilot declines.
6. Trivia cards appear at authored markers, for example *"Did you know?"* at 2:10.
7. B's subtitles are in **Spanish** (the viewer's locale). Switch the **CC** menu to English mid-playback; nothing desyncs.
8. Around **3:00**, A gets a co-pilot suggestion for the variation at 3:48. Click **Open group vote** and vote in both windows. The winning caption appears for everyone at 3:50 (`sub_bbb_05`).
9. In A's **People** tab: mute B, lock the room, use *Make host*. Close window A to see the host-disconnect policy: B pauses, and after 10 s B is promoted.
10. **End session**, then open **Past sessions → Details**. The stored analytics show *✓ Reconciles exactly* against the event log.
11. Sign in as **admin@**. On **Admin**, upload a timeline: paste broken YAML to see field-level errors, or valid YAML to add a title. You can also retrain the recommender and view live p50/p95 metrics.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (`node --watch`) and Vite client |
| `npm start` | Server only; also serves `client/dist` once it has been built |
| `npm test` | Jest: 88 tests (state machine, AI retrieval, RBAC over HTTP and WS, real-socket end-to-end, recommender) |
| `npm run seed` / `npm run seed -- --reset` | Idempotent seed / wipe and reseed |
| `npm run recs:eval` | Offline Precision@5 on the generated dataset → `docs/evidence/recs-eval.json` |
| `npm run recs:train -w server` | Batch retrain (also available as `POST /api/v1/admin/recommendations/retrain`) |
| `npm run loadtest -- --clients 10 --seconds 45` | Multi-client sync/latency load test against a running server → `docs/evidence/perf-results-*.json` |
| `node server/scripts/evidence.js` | Runs the PRD §12.2 evidence flows against a running server → `docs/evidence/*.json` |

## Headline results (measured; details in [TESTING.md](docs/TESTING.md))

| KPI | Target | Measured |
|---|---|---|
| Sync drift (50 clients) | < 100 ms target / < 250 ms ceiling | p95 **97 ms**, max 246 ms |
| Max spread between any two clients (50) | < 250 ms | max **203 ms** |
| Host pause/seek reaching all clients | < 1 s | max **7 ms** |
| Room join success | > 99% | **100%** (50/50) |
| Non-AI API P95 | < 200 ms | **8 ms** |
| AI answer P95 | < 3 s | **23 ms** in extractive mode; LLM mode is bounded by a 2.5 s timeout with fallback, but not yet measured |
| Trivia within 1 s of its marker | ≥ 95% | **100%** (15/15, p95 107 ms) |
| Precision@5 | ≥ 0.6 | **0.799** |
| Trivia factual accuracy | ≥ 90% | **Pending:** needs the manual QA pass in [docs/evidence/trivia-qa.md](docs/evidence/trivia-qa.md) |

All clients ran on one machine over loopback, so network latency was close to zero. See TESTING.md for how the player behaviour was simulated.

## Repository layout

```
server/
  src/
    index.js, app.js, config.js, db.js, logger.js, metrics.js, auth.js, models.js, util.js
    routes/        auth, titles, watchSpaces, me, admin
    realtime/      roomState.js (pure state machine), gateway.js (Socket.io)
    ai/            timelineSchema.js, retrieval.js, engine.js
    recs/          recommender.js (hybrid CB + item-item CF), service.js
    services/      eventLog.js (batched writer), analytics.js
  data/timelines/  big-buck-bunny.yaml, sintel.yaml, tears-of-steel.yaml (authored)
  scripts/         seed, seedData, trainRecs, evalRecs, loadtest, evidence
  tests/           *.test.js
client/src/        App, api.js, roomConnection.js, pages/ (Login, Dashboard, Room, Admin, SessionDetail, JoinInvite)
docs/              architecture, API, schema, testing, retrospective, postman, evidence/
```

## Security notes
- No secrets are committed. `.env` is gitignored, and the server refuses to start unless `JWT_SECRET` (at least 32 characters) is set.
- Every permission is checked on the server, both for REST routes and WebSocket events. See the RBAC tests and `docs/evidence/rbac-*.json`.
