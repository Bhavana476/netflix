# Title Timeline Schema

Admins upload one file per title, in YAML or JSON, through **Admin → Upload a title timeline** or `POST /api/v1/admin/timelines`. Nothing is saved until the whole document passes validation. Errors name the exact field, for example `events[3].characterId`, together with a plain-English message. The three authored examples are in [`server/data/timelines/`](../server/data/timelines).

Uploading a title id that already exists replaces its timeline and increments `timelineVersion`.

```yaml
title:
  id: t_1001                 # required, ^t_[A-Za-z0-9_]+$
  name: Big Buck Bunny       # required, max 200 chars
  durationSeconds: 596       # required, > 0
  genres: [Animation, Comedy] # required, non-empty (also feeds the recommender)
  videoAssetUrl: https://…/BigBuckBunny.mp4   # required, http(s):// or /media/<file>
  year: 2008                 # optional integer
  tags: [open-movie]         # optional (also feeds the recommender)
  synopsis: …                # optional
  posterColor: "#5c8a2e"     # optional, for the catalog card

characters:                  # optional list
  - id: c_frank              # ^c_…, unique
    name: Frank
    description: the leader of the three rodent bullies

subtitles:                   # optional
  version: 1
  defaultLocale: en
  lines:
    - id: sub_bbb_05         # unique
      start: 230             # seconds, end > start
      end: 236
      text: "[Bunny sighs] Not again..."
      alternates:            # optional authored localizations: locale -> text
        es: "[El conejo suspira] Otra vez no..."
        fr: "[Le lapin soupire] Pas encore..."

events:                      # required list, max 2000, any order (stored sorted by ts)
  - { id: evt_0001, ts: 5, type: trivia, importance: high, text: "…" }
  - { id: evt_0002, ts: 150, endTs: 560, type: character, characterId: c_frank, text: "optional note" }
  - { id: evt_0003, ts: 200, type: glossary, term: Flying squirrel, definition: "…" }
  - { id: evt_0004, ts: 170, type: scene, title: The bullies strike, text: "short summary" }
  - id: evt_0005
    ts: 228
    endTs: 236
    type: variation_point
    variation:
      id: v_01               # ^v_…, unique
      kind: subtitle         # subtitle | scene
      targetLineId: sub_bbb_05   # required when kind = subtitle
      prompt: How should Bunny's sigh be captioned?
      defaultOptionId: a     # used on ties
      options:               # 2-5 pre-approved options; `text` is exactly what gets applied
        - { id: a, label: Original, text: "[Bunny sighs] Not again..." }
        - { id: b, label: Exasperated, text: "[Bunny sighs] Seriously? Fruit? Again?" }
```

## Rules

| Field | Rule |
|---|---|
| `events[].id` | `^evt_…`, unique within the title |
| `events[].ts` / `endTs` | `0 ≤ ts ≤ durationSeconds`, and `ts ≤ endTs ≤ durationSeconds` |
| `events[].type` | `trivia` (needs `text`), `character` (needs `characterId` that exists in `characters`, plus `endTs`), `glossary` (needs `term` and `definition`), `scene` (needs `title` and `text`), `variation_point` (needs `variation`) |
| `importance` | `low`, `normal` (default) or `high`. With `minimal` verbosity only `high` trivia is shown |
| Text fields | No `<` or `>`. Uploads with HTML are rejected, which prevents stored XSS through metadata |
| Variations | Only the authored options can ever be applied. The AI never generates content at watch time |

## How each event type is used

| Type | Trivia cards | Q&A retrieval |
|---|---|---|
| `trivia` | shown when the playhead crosses `ts` (all verbosity levels; `high` only in minimal) | yes |
| `glossary` | shown in `chatty` mode | yes, preferred for "what does X mean" |
| `scene` | shown in `chatty` mode | yes, preferred for "what happened earlier" |
| `character` | – | yes. A character whose `[ts, endTs]` window covers the playhead counts as "on screen" for "who is that?" |
| `variation_point` | the host gets a co-pilot suggestion 45 s before `ts` | – |

Retrieval never uses events with `ts` later than the current position plus 2 s, so the co-pilot can't spoil what happens next.
