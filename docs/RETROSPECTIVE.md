# Retrospective

## What was built
One end-to-end MERN system covering all three epics:

- **Epic 1: Real-time rooms.** Invite codes and links, capacity limits, and a lock. A server-authoritative playback clock driven by the host's play, pause, seek and buffering. NTP-style clock sync, plus once-a-second drift reports answered with rate nudges or seeks. Ordered chat with typing indicators, reactions and batched persistence. Presence with connection quality. Reconnect within a grace window without a duplicate join. Host mute, remove, lock and transfer. A deterministic failover when the host disconnects: pause, then promote the earliest joiner.
- **Epic 2: AI Content Engine.** YAML/JSON timeline ingestion with field-level validation. Three fully authored titles from the Creative Commons Blender open movies. Retrieval that avoids spoilers. Grounded answers that cite the entries they used, through a hosted LLM with ID validation or a deterministic extractive fallback, and that decline when nothing relevant exists. Trivia cards on a 100 ms ticker, filtered by verbosity, plus host trivia rounds and pins. Versioned per-locale subtitle tracks. Co-pilot suggestions for upcoming variation points. Timed group votes with deterministic tie-breaks, applied identically on every client.
- **Epic 3: Dashboard and recommendations.** History with ratings, upcoming and live rooms with quick rejoin, a hybrid recommendation rail with a reason for each item, and past-session analytics whose summary is recomputed from the event log, so they always reconcile. An admin upload form with schema errors, a retrain button and live metrics.
- **Non-functional work.** JWT access and rotating refresh tokens. RBAC on every REST route and socket event. Input sanitization. Structured logs with correlation IDs. Health endpoints. A metrics endpoint. 88 automated tests. A load test at the 50-participant design capacity. Scripted evidence generation.

## What was descoped, and why
| Item | Decision |
|---|---|
| Real video splicing for scene variations | Scene variations are pre-authored insert cards overlaid between `ts` and `endTs`. The voting and timing mechanism matches the PRD. Re-editing video is outside PRD §4.2 |
| Multi-process fan-out (Redis adapter) | Single process, as allowed by PRD §14.1. Nothing in the code assumes a single room. The scaling path is documented in ARCHITECTURE.md |
| LLM latency measurement | The code supports Anthropic models with a hard timeout and fallback, but the measured numbers are for extractive mode because no API key was available. This still needs measuring |
| Manual trivia accuracy QA | A checklist was prepared (`docs/evidence/trivia-qa.md`), but someone has to watch the clips to complete it |
| Browser screen recordings | The flows are proven by real-socket tests and the evidence script. The two-tab recording still needs to be captured by a person |
| Recommendation model depth | A simple hybrid (content cosine plus item-item cosine CF with history-dependent blending) instead of matrix factorization. It reaches P@5 = 0.80 on the generated data, and it's explainable, which is what lets the rail say "Because you watched X" |

## What went well
- Keeping `RoomState` free of I/O, with an injectable clock, made the hardest logic (drift, failover, vote ties, trivia crossing) fast to test thoroughly.
- Computing the analytics summary *from* the event log made the reconciliation acceptance criterion true by construction.
- The load test found a real bug. Clock-sync pings sent before `room.join` were rejected, which corrupted the first-join offset. It also gave a data-driven reason to lower the drift threshold from 100 ms to 50 ms, which took P95 drift from 140 ms to 98 ms.

## What I'd do next with more time
1. Measure LLM-mode latency and grounding quality, including a small evaluation set of question → expected entry ID pairs to track retrieval precision.
2. Add embedding-based retrieval alongside the lexical scorer, for paraphrased questions.
3. Add the Redis adapter and a room-to-node assignment so rooms can be spread across processes, then load-test multiple rooms at once.
4. Add a Playwright test that opens two real browser contexts and asserts the `<video>` currentTime gap. This would replace the simulated players in the drift measurement.
5. Hand-verify every authored timestamp frame by frame and finish the trivia QA sheet.
6. Matrix-factorization CF (ALS) and an online evaluation using real co-watch data.
7. Add CI. (Git was not available while building, so the repository was initialized afterwards with commits grouped by layer, not day-by-day history. It still needs pushing to a remote.)
