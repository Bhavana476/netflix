# Test & Performance Report

Measured on 2026-10-23 on Windows 11 x64 with Node 24.15 and embedded MongoDB 7.0.14. Every number below was produced by running the scripts in this repo; none are estimates. The raw outputs are in [`docs/evidence/`](evidence/).

## 1. Automated tests: 80 passing

Run with `npm test` (Jest, in band). Each test file starts its own in-memory MongoDB and a real HTTP + Socket.io server on a random port. Full output: [`evidence/test-report.txt`](evidence/test-report.txt).

| Suite | Tests | What it would catch |
|---|---|---|
| `roomState.test.js`, **playback state machine** | 27 | Clock advances only while playing. Seek keeps play/pause state. Buffering holds the clock. Position is clamped to duration. `seq` increases monotonically. Non-host and invalid transitions are rejected. Drift decisions (none / rate / seek) use the report timestamp. Reconnects aren't counted as new joins. Capacity, lock and removal are enforced. Host failover is deterministic (pause, then promote the earliest joiner with userId tie-break). Each trivia marker fires once and seeks skip markers. Vote tally, tie-breaks and host-only rules |
| `aiRetrieval.test.js`, **AI retrieval and grounding** | 18 | Intent detection. "Who just walked in" returns only the most recent on-screen character. Glossary preferred for "what does X mean". **No spoilers** (nothing after the playhead). Irrelevant questions retrieve nothing, so the co-pilot **declines** rather than guessing. Answers cite only real timeline IDs. Verbosity controls how many entries are used. Subtitle locale and variation resolution. Schema validation with exact error paths. YAML line numbers in parse errors |
| `rbac.test.js`, **access control (HTTP + WS)** | 18 | 401 for missing, forged and expired tokens. Access TTL ≤ 1 h. Refresh rotation and replay rejection. Self-registration can't grant admin. All 6 admin routes return 403 for viewer and host. Viewers can't create rooms. Invite-only rooms are closed to non-members. Participants can't end a room. The WS handshake needs a JWT. All 6 host-only WS events are rejected for a viewer. Outsiders can't join over WS. Chat is sanitized (no stored XSS) |
| `realtime.test.js`, **end-to-end over real sockets** | 12 | Play, pause and seek reach 3 participants in under 1 s. A mid-playback joiner lands within 250 ms. Clock-sync ping works before join. 10 chat messages arrive in order for everyone. History survives a reconnect with no duplicate `joined`. Grace-window expiry produces `left`. Host disconnect pauses, then promotes. A host who returns keeps the role. A trivia card arrives within 1 s of its marker. The vote result is byte-identical on all clients and causes no playback update. REST Q&A is grounded and broadcast. The session summary reconciles with the event log, and interactions are recorded |
| `recommender.test.js` | 5 | Implicit scoring. CF neighbour signal. The rail reacts to new interactions without retraining. Cold start uses genre affinity. **Offline Precision@5 ≥ 0.6** |

> Note: Jest sometimes prints "A worker process has failed to exit gracefully" after all suites pass. `--detectOpenHandles` reports no leaked handles in our code. The message comes from the embedded `mongod` child process shutting down asynchronously, and it doesn't affect results.

### Bugs the tests caught during development
- **"Who won the 1998 World Cup?" was answered with on-screen characters.** The "who" intent boosted any on-screen character. The boost now applies only when the question actually points at someone.
- **Clock sync before join was rejected.** `room.sync.ping` needed a joined room, so first-join drift calculations used an undefined offset. The load test exposed this with NaN drift samples. Ping is now stateless.
- **Answers padded with loosely related entries.** For example, "Who directed this?" also listed the squirrels on screen. Retrieval now drops entries scoring under 75% of the best match.

## 2. Performance vs. Section 10.2 targets

Load-test harness: `npm run loadtest -- --clients N --seconds 45` (server must be running). Each simulated participant follows the real protocol: clock sync by ping, a drift report every second, and applying `rate`/`seek` corrections. To make drift realistic, every simulated player has a **±0.6% clock skew** and **40–200 ms latency** when applying a snapshot (standing in for `<video>` seek and start time). All clients run on one machine over loopback, so they share one wall clock and drift is measured exactly. It also means network latency is near zero, which is the main limitation of these numbers.

Drift is sampled every 250 ms per client after a 4 s warm-up. Samples taken within 400 ms of a host pause or seek are excluded, because that transition is measured separately as propagation (8 and 6 samples were excluded in the two runs).

| Dimension | Target | 10 clients | **50 clients** (47 steady + 3 late joiners = design capacity) | Result |
|---|---|---|---|---|
| Sync drift vs. authoritative clock | < 100 ms target, < 250 ms ceiling | p50 32 / **p95 98** / max 229 ms | p50 29 / **p95 97** / max 246 ms | ✅ p95 meets target; max within ceiling |
| Max spread between any two clients (KPI "any two participants") | < 250 ms | p50 90 / p95 166 / max 169 ms | p50 98 / p95 203 / max 203 ms | ✅ |
| Mid-playback join to within 250 ms | ≤ 2 s | max 171 ms | max 141 ms | ✅ |
| Host pause/seek reaches all clients | < 1 s | max 4 ms | max 7 ms | ✅ |
| WS fan-out, server send to last client | < 500 ms | p95 2 ms | p95 16 ms | ✅ |
| Room join success | > 99% | 10/10 | 47/47 (+3/3 late) | ✅ The capacity limit correctly refused a 53rd joiner in a separate run |
| Non-AI API latency (titles, timeline range, room, recommendations) | P95 < 200 ms | p95 8.4 ms | p95 7.9 ms | ✅ |
| AI co-pilot answer, end to end over REST | P95 < 3 s | p95 30 ms | p95 23 ms | ✅ **extractive mode** (see note) |
| Trivia card within 1 s of its marker | ≥ 95% of markers | **15/15 markers (100%)**, p95 107 ms ([trivia-timing.json](evidence/trivia-timing.json)) | | ✅ |
| Recommendation Precision@5 (offline) | ≥ 0.6 | **0.799** mean over 3 seeds (0.810 / 0.773 / 0.813) ([recs-eval.json](evidence/recs-eval.json)) | | ✅ |

**AI latency note.** These runs used the deterministic extractive answerer because no `ANTHROPIC_API_KEY` was configured. With a key, the latency is dominated by the hosted model. The code puts a hard upper bound on it: `AI_TIMEOUT_MS` (2.5 s) aborts the LLM call and falls back to the extractive answer, which keeps P95 under 3 s by construction. That LLM-mode figure has **not** been measured yet. To measure it, set the key, run `npm run loadtest`, and read `aiAnswerLatencyMs`.

**Tuning record.** With the correction threshold at 100 ms, the 10-client run measured drift p95 = 140 ms and max = 226 ms. Lowering the threshold to 50 ms brought p95 down to 98 ms. Rate nudges of ±8% or less over a second or two are not noticeable to viewers, so correcting earlier costs nothing visible.

Raw outputs: [`perf-results-10clients.json`](evidence/perf-results-10clients.json), [`perf-results-47clients.json`](evidence/perf-results-47clients.json), [`server-metrics.json`](evidence/server-metrics.json).

## 3. Functional evidence (Section 12.2)

`node server/scripts/evidence.js` (server running, seeded passwords in `.env`) runs the demo paths against the real seeded accounts and writes these files:

| Evidence | File | Result |
|---|---|---|
| RBAC rejected server-side | [rbac-rejections.json](evidence/rbac-rejections.json), [rbac-websocket-rejection.json](evidence/rbac-websocket-rejection.json) | viewer or host → admin upload: 403. Viewer → create room: 403. No token: 401. Malformed timeline: 422 with paths. Viewer `room.playback.update` over WS: `NOT_HOST` |
| Grounded Q&A with source entries | [ai-qa-exchanges.json](evidence/ai-qa-exchanges.json) | 4 grounded answers, each citing its `evt_*` entries, and 1 off-topic question declined with `sourceEvents: []` |
| Subtitle swap and group vote applied | [variation-and-subtitles.json](evidence/variation-and-subtitles.json) | The `es` locale line replaces the `en` line. 3 clients received identical `room.variation.applied` payloads 0 ms apart, and 0 playback updates followed the swap |
| Recommendation rail and its data | [recommendation-rail-viewer.json](evidence/recommendation-rail-viewer.json), [recommendation-rail-update.json](evidence/recommendation-rail-update.json) | The rail re-ranked after a new rating while `modelTrainedAt` stayed the same (no retrain) |
| Analytics reconcile with the event log | [session-analytics-reconciliation.json](evidence/session-analytics-reconciliation.json) | `reconciles: true` (peak 3, AI questions 5, trivia 15, chat 2, reactions 1) |
| Trivia accuracy (QA pass) | [trivia-qa.md](evidence/trivia-qa.md) | See that file: facts checked, and timing checked against video frames ([timing-frames/](evidence/timing-frames/)) |

### Two-browser demo (screenshots)

Captured on 2026-10-27 by driving two separate headless Microsoft Edge sessions (separate cookie and storage contexts) through the real UI with `puppeteer-core`. The host is "Hana" and the viewer is "Vik", whose subtitle locale is `es`. The viewer joined through the invite link, `/join/<code>`. Both played the real Big Buck Bunny stream from archive.org. The full step log is in [screenshots/demo-log.txt](evidence/screenshots/demo-log.txt), and each step has a `-host.png` and a `-viewer.png` in [evidence/screenshots/](evidence/screenshots/).

| Step | Screenshots | What it shows |
|---|---|---|
| Playing in sync | `01-sync-playing-*` | After the host's seek to 2:20, the gap between the two `<video>.currentTime` values over 5 one-second samples was 25, 12, 12, 12 and 12 ms. The host's pause reached the viewer: viewer `paused = true`, gap 23 ms |
| AI co-pilot Q&A | `02-ai-copilot-*` | "Who is the character that just walked in?" → Frank, citing `character · Frank @ 2:30`. "Who won the World Cup?" → declined, with no matching timeline entry |
| Subtitle localization swap | `03-subtitle-es-*`, `04-subtitle-swapped-en-*` | The viewer saw "[El conejo bosteza y se estira]". Switching CC to English mid-playback changed it to "[Bunny yawns and stretches]", and the two clients stayed 9 ms apart |
| Group vote applied | `05-vote-open-*`, `06-variation-applied-*` | Vote "How should Bunny's sigh be captioned?": 2 of 2 voted "Exasperated". At 3:50 both clients showed "[Bunny sighs] Seriously? Fruit? Again?", 10 ms apart |

The seek to 2:20 took 12.7 s to resume because archive.org was slow to fetch that part of the video. During that time the room held everyone in `buffering` and then resumed them together, as designed. A screen *recording* with audio, for the walkthrough in PRD 13.1, still needs a person.
