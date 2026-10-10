# Background / Metadata Only mode (fork of Horae 1.15.1)

This fork adds a second state-tracking mode to Horae. The GM (and any other character card) writes **only the story**. After each reply completes, Horae sends a separate request to the Auxiliary API in the background. That request extracts state changes from the reply, and Horae saves them **only to metadata** (`chat[i].horae_meta`). `message.mes` is never modified.

The original behavior is still available as **Legacy / Inline tags**, where the main model appends `<horae>` / `<horaeevent>` / `<horaerpg>` tags to its replies. Both modes use the same stored data format, UI, RPG system, and vector memory.

---

## 1. Installation and activation

1. Install the fork like any third-party extension. The folder name must stay `SillyTavern-Horae` because Horae loads its templates from `third-party/SillyTavern-Horae`:
   - **Extensions → Install extension**, then enter your fork's Git URL, or
   - copy or clone this repository into `SillyTavern/data/<user>/extensions/SillyTavern-Horae` (or `public/scripts/extensions/third-party/SillyTavern-Horae`).
2. Reload SillyTavern.
3. Open the Horae drawer and go to **Settings**:
   - **State tracking mode** → `Background analysis / Metadata only`. Fresh installs of this fork default to this mode. **Existing installs keep `Legacy`** until you switch, and nothing else in your settings changes.
   - **Automatically analyze new AI replies in the background**: on (default).
   - **Wait for background analysis before sending**: on (default), with a 60 s cap.
4. Under **Auxiliary API**, enable the auxiliary API and set the URL (OpenAI-compatible, e.g. `https://…/v1`), the key and the model. Keep **"AI analysis, magic wand…"** checked. **"Fall back to main API on failure"** keeps your existing choice (off by default).
   - If the auxiliary API is disabled entirely, the analysis uses the main API through `generateRaw` (same as the existing Horae "AI analysis"). It never starts a normal narrative generation and never adds messages to the chat.
5. Auto-summary and auto-hide are **not** turned on by this fork. Leave them off if you don't want them.

### Minimal smoke test

1. Start a **new chat** with your GM card.
2. Send one action. The GM reply appears as plain prose.
3. The Horae bar under the reply shows a badge: `Queued` → `Analyzing` → `Synced` (or `No changes`).
4. Open the Horae drawer. Characters, items, RPG HUD and timeline reflect the reply.
5. Optional: open the message editor. `mes` contains only the prose.

---

## 2. GM card / prompt cleanup guide

In Metadata mode Horae never asks the main model to output anything. Remove the old output instructions from your GM card, system prompt, Author's Note and lorebooks. Otherwise the GM keeps writing them into the story:

| Remove | Examples |
|---|---|
| Horae sync / output rules | `# Horae同步`, "回复末尾必须包含 `<horae>`…", `<horaeevent>` / `<horaerpg>` / `<horaetable:…>` templates |
| Bare state-dump formats | `time:` / `location:` / `characters:` / `costume:` / `skill:` / `item:` lines the GM was told to print |
| Custom status-sync formats | `[获得物品…]`, `[状态更新…]`, `【HP变化】…` and similar "print a status line" directives |
| Regexes that only existed to hide those dumps | optional; Horae's own hiding regexes stay installed for Legacy mode and do no harm |

**Keep everything else.** The GM's narrative control, Fate/TYPE-MOON lore, character definitions and the Servant-tool instructions (`RandomServant`, `SummonServant`, `SaveServant`, `GetServant`) need no changes. The separate Servant extension and its `chatMetadata.createServant` state are untouched by this fork.

The GM still **receives** the current world state (time, place, present characters and outfits, items, NPCs, relationships, HP/MP/SP, skills, equipment, timeline, vector recall). The snapshot header is now read-only: *"Current State Snapshot — recorded automatically from the story so far, for narrative continuity reference"*.

---

## 3. How it works

```
USER action → GM reply (normal generation, plain prose)
  → CHARACTER_MESSAGE_RENDERED (only for freshly generated replies)
  → background job queued {chatKey, message object, swipe_id, text fingerprint}
  → Auxiliary API: analyzer prompt = state BEFORE this reply + preceding USER action + this reply
                   + format reference for every enabled module (core, RPG, tables, relationships, mood, scene memory)
  → strict parse of the private reply (existing parseHoraeTag; no loose parsing of prose)
  → identity re-checked (same chat, same message, same swipe, same text) – stale results are discarded
  → this message's horae_meta is REPLACED with the new delta (existing mergeParsedToMeta / applyParsedToMessage)
  → chat[0] aggregates rebuilt if needed (rebuildRpgData / Relationships / LocationMemory / TableData)
  → marker horae_meta._bg = {status, fp, swipeId, at}; save chat; refresh UI; update vector entry
  → next generation waits (bounded) for pending analysis, then injects the committed state
```

* **Private protocol.** The analyzer replies with Horae's existing tag syntax (`<horae>`, `<horaeevent>`, `<horaerpg>`, `<horaetable:…>`) or `<horaenochange/>`. These replies are only read by the parser and never reach `mes`, the visible chat or the GM's history. Replies without any recognized block are rejected as invalid; prose is never loose-parsed.
* **One commit per version.** Jobs are deduplicated per message object + swipe + text fingerprint, run one at a time in story order, and are re-validated before commit. Re-renders, duplicate events, retries and late results cannot double-apply damage, items or events.
* **Persistence.** Per-message deltas live in `chat[i].horae_meta` (unchanged format). `chat[0].horae_meta` keeps the aggregates as before. New fields:
  * `horae_meta._bg`: `{ v, status: 'done' | 'nochange' | 'failed', fp, swipeId, at, error? }`. "Analyzed, no changes" is a first-class success.
  * `horae_meta._manualRpgEdits`: HUD edits made in Metadata mode. They are re-applied over AI deltas when that message is re-analyzed.
  * `message.horae_bg_swipes`: per-swipe cache (keyed by text fingerprint) of that message's own delta, so switching back to an analyzed swipe needs no new request.
* **Lifecycle.**
  * **New reply:** analyzed once.
  * **Regenerate:** the old message is deleted and the existing rebuild revokes its delta.
  * **Swipe:** the old version's state stops applying immediately. The newly selected version is restored from the cache or analyzed once it has finished generating.
  * **Edit:** the reply is re-analyzed and its delta is replaced. If re-analysis fails, the previous delta stays. Editing a USER message re-analyzes the following AI reply.
  * **Delete:** the existing rebuild revokes the delta.
  * **Chat switch:** queued jobs are dropped, and in-flight results are rejected by chat key. When you return, an interrupted tail reply is analyzed once.
  * **Reload:** markers persist and no analysis wave starts.
* **Group chats.** All replies update one shared state. If several AI replies follow one USER message, only the first one settles the USER action. Later replies receive it labeled *ALREADY SETTLED, context only*.
* **Failures** (missing key, HTTP error, timeout of 180 s, empty or malformed reply, commit error) leave prose and previous state untouched. Horae writes a `failed` marker with the reason, shows a toast and an orange/red badge, and the badge is clickable to retry. Commit errors roll back both the message meta and the `chat[0]` aggregates.

### Message badge states

| Badge | Meaning | Click |
|---|---|---|
| Synced | delta extracted and saved | re-analyze (asks first) |
| No changes | analyzed, nothing changed | re-analyze (asks first) |
| Queued / Analyzing | in the background queue | – |
| Failed · Retry | last attempt failed, state untouched (tooltip shows reason) | retry |
| Outdated | text was edited after analysis | analyze |
| Not analyzed | never analyzed (e.g. old chat, auto-analysis off) | analyze |

The magic wand and the rescan buttons on a message also run a (forced) background re-analysis in this mode. Quick-scan never loose-parses prose in this mode.

---

## 4. Settings reference (new)

| Key | Default | Notes |
|---|---|---|
| `stateMode` | `metadata` on fresh install, `legacy` for existing installs | persistent; switching never erases data |
| `bgAutoAnalyze` | `true` | auto-analyze freshly generated replies |
| `bgWaitBeforeSend` / `bgWaitTimeoutSec` | `true` / `60` | bounded wait in prompt-ready; no deadlock (analysis requests are marked to skip Horae's own injection) |
| `customBgAnalysisPrompt` | empty (built-in zh / en default) | placeholders `{{state}} {{previousUserMessage}} {{content}} {{speaker}} {{modules}} {{user}} {{char}}` |

All of these keys are included in Horae's profile export / card-profile whitelist. API URL, key and model remain excluded as before.

`window.Horae` additionally exposes `getStateMode()` and `background.{getStatus(i), isBusy(), waitForIdle(ms), reanalyze(i)}`.

---

## 5. Audit of paths that modified `message.mes` and how each was adapted

| Path | Legacy behavior | Metadata mode |
|---|---|---|
| `onMessageReceived` → `processAIResponse` (+ `parseLooseFormat` fallback) | parse tags/loose text from prose | not used; background analysis instead |
| `_sanitizeThinkBlockHoraeTags` (rewrites `<think>` content in `mes`) | runs | not used (`mes` untouched) |
| `onMessageEdited` / `onSwipePanel` (reset meta, re-parse `mes`) | re-derive from prose | fingerprint check → re-analysis / swipe cache; never re-parse prose |
| `injectHoraeTagToMessage` callers: panel save, quick-scan, AI analyze, rescan, NPC add/edit/rename/delete, relationship edit/delete, item delete, timeline/summary edit, orphan summary-card repair, batch AI scan (+ review/undo/recovery), pre-send auto-fill | write metadata, then serialize tags into `mes` | every caller already writes `horae_meta` first. The writeback returns early, and since nothing re-parses prose in this mode, metadata is the only source. Verified by E2E reload checks |
| `commitRpgEdit` → `injectHoraeRpgLinePatch` (HUD) | append `<horaerpg>` to `mes` | writes `_rpgChanges` + `_manualRpgEdits` only (E2E: `mes` byte-identical, survives reload and rebuild) |
| `_autoFillPreviousAiTimelineBeforeInjection` (pre-send repair; loose parse + writeback) | optional | replaced by a bounded wait for pending background analysis |
| `rescanMessageMeta` (clears meta when no tags are found) | runs | routed to background re-analysis (cannot wipe data) |
| Quick-scan button (`parseLooseFormat(mes)`) | runs | routed to background re-analysis |
| Carryover new-chat seed (`chat[0].mes = <horae>…`) | writes tags into the anchor message | skipped; the seed lives in `horae_meta` |
| `_sanitizeLeakedHoraeTags` (DOM only) | runs | skipped (display shows prose exactly) |
| Anti-paraphrase reference footer ("must consolidate into `<horae>`") | injected | not injected |
| `generateSystemPromptAddition` (+ custom system prompt, RPG/table/relationship/mood/location/calendar rules) | injected | returns empty |
| `generateCompactPrompt` header "only output changed fields in `<horae>`", table "please fill" hints | injected | read-only header; table fill hints go only to the analyzer |
| Legacy hiding regexes (`ensureRegexRules`) | installed | still installed, but correctness does not depend on them |

---

## 6. Test report

Environment: Windows 11, Node 24.20.0, **SillyTavern 1.19.0 `release` (06bde93)** with this fork linked as a third-party extension, Chromium (Playwright). For the main GM model, the auxiliary API and the embeddings, a local OpenAI-compatible **mock** (`tests/e2e/mockServer.mjs`) returned scripted replies. It logged every request, so the exact prompts sent to the main model could be inspected.

### Automated unit tests: `node --test tests/*.test.mjs` → **34 / 34 pass**

These run the real `horaeManager` (prompts loaded from `prompts/`) and the new `core/bgAnalysis.js`. They cover:

* strict parsing (tagged / no-change / think-block / bare `time:`-style prose rejected / RPG-only)
* the scheduler: dedupe, story order, chat-switch, swipe and edit stale rejection, failure marking and retry, `waitForIdle` timeout
* data semantics for acceptance scenarios 1–8, 11, 12, 15 and 16:
  * HP 96→84, then no re-damage
  * skill add/upgrade without duplicates over 10 turns
  * badge pick-up / bag / hand-over / loss
  * equip
  * NPC + affection + relationship
  * scene/time/events, and a no-change turn
  * swipe rollback, and edit-revokes-delta
  * group-chat no duplicate
  * HUD override survives re-analysis
* prompt separation (scenario 20) and legacy tag behavior (scenario 18)
* RPG format adaptation for the analyzer in 5 languages
* message #0 chat-wide data preservation
* the "no greeting + config-only `rpg`" regression

A mutation check (disabling the rebuild on replace) makes the relevant tests fail as expected.

### End-to-end in real SillyTavern: `tests/e2e/run.mjs` → **57 / 57 checks pass** (run several times in a row; the last two runs were clean)

* **S1:** prose byte-identical to the GM output, no tags in any `mes`.
* **S2:** HP 96→84, a dialogue turn doesn't re-damage.
* **S3:** skill once with details.
* **S4:** item stored once.
* **S5:** NPC and affection.
* **S6:** next-turn injection carries the state.
* **S8:** a no-change turn is recorded as `nochange` with no invented data.
* **S9:**
  * HTTP 500 → state untouched, visible failed badge, retry via badge applies.
  * Malformed reply is rejected.
  * A missing key with fallback off fails without a request.
  * With the aux API disabled, analysis is routed through the main API, adds no chat message, and gets no double injection.
* **S10:** reload keeps per-message meta, markers, aggregates and vectors, and history rendering sends 0 analysis requests.
* **S11:**
  * The old swipe applies damage; selecting the new swipe rolls HP back.
  * Swiping back restores from cache with **no new request**.
  * Old swipe prose is untouched.
* **S12:** editing an older message replaces its delta and later state is rebuilt.
* **S13:** an immediate next turn waits (~3 s) and sees the committed location.
* **S14:**
  * A late result from chat A is never written into chat B.
  * The interrupted analysis resumes once when returning to A.
* **S15** (group with 2 cards, LIST activation):
  * Both replies are analyzed.
  * The 2nd reply sees the USER action as `ALREADY SETTLED`.
  * No messages are added; the item is counted once.
* **S16:** HUD edit via the real HUD input:
  * state updates immediately
  * all `mes` byte-identical
  * survives reload/rebuild
  * the GM sees `70/100` next turn
* **S17:** the vector index is built from metadata (4 docs) and persisted across reload.
* **S18:** Legacy mode still instructs `<horae>`, parses the inline tags, hides them with the regexes, and sends no background requests.
* **S19:** auto-summary not forced on; all Horae tabs and 5 regex rules present.
* **S20:** the main request contains no `<horae>`/`horaeevent`/`horaerpg` instruction; the aux request is separate.

### Settings migration (`tests/e2e/migration.mjs`) → **5 / 5 pass**

* A fresh install defaults to Metadata and does not enable auto-summary.
* An existing install without `stateMode` migrates to Legacy, and its other settings are preserved.
* An explicit Metadata choice survives reload.

### Not executed / limits of the tests

* **No real LLM was used.** Analyzer and GM replies were scripted. These tests prove the plumbing (separation, parsing, persistence, ordering, rollback, UI), not the extraction quality of a particular model (e.g. Qwen). Run the smoke test above with your real auxiliary model, and review a real analyzer request (`node tests/e2e/dumpPrompt.mjs` against the mock, or the browser network tab).
* **Scenario 1's 800–1,200-character prose** was exercised with ~620-character scripted Chinese prose; length has no effect on the code path.
* **No mobile browsers and no other ST versions** were tested.
* **Auto-summary / auto-hide interplay** was only checked for "not forced on". Their behavior with Metadata mode turned on was not exercised end-to-end, although their code paths do not write `mes`.

### How to rerun

```bash
node --test tests/*.test.mjs                       # unit tests, no ST needed
node tests/e2e/mockServer.mjs 5555                 # terminal 1
node server.js --port 8000                         # terminal 2, inside a SillyTavern checkout with this fork installed
PLAYWRIGHT_PATH=<dir with playwright>/package.json node tests/e2e/run.mjs
PLAYWRIGHT_PATH=... ST_DATA=<ST>/data/default-user node tests/e2e/migration.mjs
```

The E2E suite configures ST's main API (Custom OpenAI-compatible → mock) and Horae's auxiliary API itself. Run it against a **throw-away** ST data directory: it creates chats and a group, and `migration.mjs` temporarily rewrites `settings.json` (it restores the file afterwards).

---

## 7. Known limitations / risks

* **Extraction quality depends on the auxiliary model.** The analyzer can still misread a story. The guarantees are separation from the narrative, strict validation, one commit per message version, and failures that never corrupt existing state. Use the badge to re-analyze, or edit the panel or HUD manually.
* **Ordering of re-analysis.** If an *older* message is re-analyzed after later messages, the later deltas are not re-analyzed. They are replayed as recorded. Most fields are absolute values (HP `cur/max`, holder/location), so replay stays correct, but a later message's analysis was originally done against the old prior state.
* **Manual panel edits vs. prose edits.** Editing a message's metadata in the message panel persists. If you later **edit that message's prose**, the re-analysis replaces that message's delta and panel edits on that same message are lost. HUD edits (`_manualRpgEdits`) are preserved. Edits on other messages and chat-wide data are never affected.
* **Per-message panel shows the delta.** In Metadata mode a reply's panel shows only what changed in that reply (e.g. `--` time, "0 present characters" when nothing changed). The RPG HUD falls back to the latest known cast so it remains visible on every reply.
* **Batch AI scan / summary cards** still work and write metadata directly, but messages filled by batch scan show `Not analyzed` badges. Clicking one re-analyzes that message with the background analyzer.
* **Old chats** from Legacy mode keep their tag-derived metadata. Switching to Metadata mode does not re-analyze history. Only new replies, or replies you click, are analyzed. Starting a new chat is recommended.
* **Pre-existing, unrelated issue (not changed):** `index.js` calls `TavernHelper.injectPrompts` on every generation and logs `ReferenceError: TavernHelper is not defined` when the JS-Slash-Runner / TavernHelper extension is absent. SillyTavern catches it and generation proceeds.
* The analyzer request uses temperature 0.3 and a 180 s timeout. Legacy AI tasks keep their previous parameters.
