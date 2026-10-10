\# Horae Fork Requirements: Background State Extraction and Metadata-Only Persistence



> \*\*Intended recipient:\*\* A coding agent running from the root of the user's \*\*already-forked and checked-out\*\* `SillyTavern-Horae` repository.  

> \*\*Project type:\*\* Targeted changes to the existing Horae extension; \*\*not\*\* a replacement RPG tracker or a rewrite.  

> \*\*Baseline:\*\* Upstream `SenriYuki/SillyTavern-Horae`, whose `manifest.json` reported version `1.15.1` when reviewed. \*\*Inspect the code actually present in the current working directory\*\* before implementation. The paths and function names below are investigation leads, not assumptions that override the checked-out source.  

> \*\*Priorities:\*\* Correctness, data integrity, and maintainability > minimizing changed lines > performance optimization > visual polish.  

> \*\*Fundamental rule:\*\* \*\*The GM writes the story. Horae independently analyzes the completed story in the background and persists state to metadata. Horae must never write state tags into story text as a persistence mechanism.\*\*



\## 0. Instructions to the Coding Agent



1\. The current working directory is \*\*already the root of the user's Horae fork\*\*. Do not fork again, clone upstream unnecessarily, assume another repository path, or modify upstream directly.

2\. First audit the existing state lifecycle: prompt injection, AI analysis, message events, RPG state merging, UI editing, vector indexing, and regenerate/swipe/edit/delete flows. Inventory every path that reads or modifies `message.mes`, especially paths that serialize metadata back into tags.

3\. Implement a selectable \*\*Background / Metadata Only\*\* mode without breaking the existing behavior. The original inline-tag mode must remain functional.

4\. \*\*Do not delete existing functionality or perform a sweeping refactor.\*\* Keep automatic summarization, auto-hide, vector memory, characters, relationships, timeline, RPG features, UI, presets, and regex support. The user can simply leave unwanted features disabled. This task addresses the core pain point and only the dependencies necessary to solve it reliably.

5\. Run applicable checks and tests. Deliver a change summary, actual test results, known limitations, and installation/activation instructions. Do not mistake “code has been written” for “the feature has been verified.”



\## 1. Background and Actual User Requirements



The user runs long-form text RPGs in SillyTavern, with a dedicated GM character card and lorebooks (including Fate/TYPE-MOON). They may also use \*\*group chats containing a GM card, one or more independently controlled character cards, and the human USER\*\*.



Horae already provides useful interfaces and state management for characters, scenes, timelines, relationships, affection, inventory, skills, RPG HP/MP/SP, equipment, strongholds, etc. The user also wants to keep \*\*Horae's own vector-memory functionality\*\*.



The problem is the existing architecture: the main narrative model is instructed to include structured blocks such as `<horae>`, `<horaeevent>`, `<horaerpg>`, and `<horaetable:...>` in its normal response. Horae then parses these blocks and relies on regex rules to hide them. Qwen frequently omits delimiters, prints bare `time:` / `costume:` / `skill:` lines, or leaks long metadata dumps into the visible prose. Such output may not be parsed correctly either. Adding more GM instructions or hiding regexes cannot provide a reliable architectural boundary.



Furthermore, some Horae editing, synchronization, and completion paths \*\*actively serialize metadata back into `message.mes`\*\*. Preventing the model from generating tags is therefore necessary but not sufficient.



The user wants all of the following:



\- Story prose that remains clean and readable, with no automatic state-recording text and no need for regex rules to conceal it.

\- Automatic extraction of state changes from \*\*completed, ordinary story responses\*\*, continuously tracking characters, HP/MP/SP, skills, inventory, relationships, timelines, and other existing Horae data.

\- Real, persistent structured data that the existing UI can inspect/edit, and that is made available to the model in subsequent turns.

\- Continued use of Horae's existing vector-memory engine.

\- Maximum reuse of the mature existing code rather than reimplementing the entire RPG system.

\- An additional independent AI request per turn is acceptable. Prefer Horae's existing \*\*Auxiliary API\*\* configuration and infrastructure.



\*\*The user can freely start a new chat. Complex migration of historical chats and a dedicated backup tool are not required in this task.\*\* However, do not break the existing stored-state format, the legacy mode, or normal message-editing behavior. New chats must work reliably.



\## 2. Non-Goals and Functionality That Must Remain



\- \*\*Do not delete\*\* any existing subsystem, settings panel, or gameplay feature. In particular, retain auto-summary and automatic `/hide`. Do not silently enable them, and do not take this opportunity to fix or rewrite their unrelated known issues.

\- \*\*Do not build a new RPG data model or HUD.\*\* Reuse the existing NPC, affection, relationship, item, costume, scene, event, agenda, RPG bars/status/skills/equipment/attributes/reputation/levels/currency/strongholds, and custom-table structures.

\- \*\*Do not require the user to modify the GM character card to emit tags.\*\* They should be able to delete old `# Horae同步` rules and custom `\[获得物品...]`-style output directives without losing automatic tracking.

\- \*\*Do not change the separate Servant extension.\*\* Leave its `chatMetadata.createServant` state and `RandomServant`, `SummonServant`, `SaveServant`, and `GetServant` tools untouched.

\- \*\*Do not introduce a new server or external database\*\* unless examination of the source demonstrates that it is unavoidable and the user explicitly agrees.

\- Do not promise that an AI will never misunderstand the story. The achievable requirements are \*\*strict separation from narrative output, reliable formatting/validation/persistence, and failure handling that does not corrupt existing state\*\*.



\## 3. Target Architecture and Source of Truth



\### 3.1 Intended Processing Flow



```text

USER submits an action

&#x20;   ↓

GM (or an independently controlled character in a group chat)

finishes a normal narrative response

&#x20;   ↓

Horae detects that specific completed AI message

&#x20;   ↓

Independent background AI request:

&#x20; this AI message's prose + relevant USER action + prior state

&#x20;   ↓

Auxiliary model returns structured state deltas

&#x20; (visible only inside the extension)

&#x20;   ↓

Strict parsing/validation → apply existing Horae merge semantics

&#x20;   ↓

Persist changes in that message's horae\_meta;

update required aggregate state

&#x20;   ↓

Refresh UI / vector index; persist chat

&#x20;   ↓

Next normal generation receives current state and relevant memories,

NOT instructions to emit structured state tags

```



\### 3.2 Persistence: \*\*Prefer Existing `horae\_meta`; Do Not Blindly Move Everything to `chatMetadata`\*\*



The upstream source already uses:



\- `chat\[i].horae\_meta` for per-message changes and events.

\- `chat\[0].horae\_meta.rpg` and related structures for aggregated RPG data, relationships, location memory, and associated configuration.

\- `getLatestState()`, `getRpgData()`, `getRpgStateAt()`, `rebuildRpgData()`, etc. for state reads, replay, and rollback.



`chat\[i].horae\_meta` \*\*is already metadata; it is not the narrative text stored in `chat\[i].mes`\*\*. Keeping the per-message delta model is advantageous for swipes, edits, deletions, and regenerations. Unless there is a compelling technical reason, do \*\*not\*\* replace this with a single mutable `chatMetadata` snapshot: doing so would require rebuilding event history/rollback and could break the existing UI and APIs.



\*\*Authoritative-data rule:\*\* Structured state lives in metadata. `message.mes` holds only the text actually written by the user or narrative character. Re-serializing state tags into prose must never be used to persist metadata.



\### 3.3 Internal Protocol for the Independent Analysis Model



\*\*Prefer reusing\*\* existing capabilities such as `analyzeMessageWithAI()`, `\_generateForAuxTask()`, and `parseHoraeTag()` rather than implementing an unrelated JSON/RPG parsing stack.



\- The auxiliary model \*\*may\*\* continue using the existing `<horae>`, `<horaeevent>`, and `<horaerpg>` syntax in its \*\*private response\*\* as an internal RPC/data format. Its raw output must never be copied into any chat message's `mes`, the visible narrative UI, or the ordinary generation history.

\- Strict JSON or another more reliable private protocol is also acceptable \*\*if\*\* it supports all enabled modules, preserves existing Horae semantics, and is adequately tested. Reusing existing parsing and merge logic is the default recommendation.

\- The background analyzer must fully support the \*\*RPG modules\*\*, not just basic scene fields. The current `prompts/zh-CN/customAnalysisPrompt.txt` principally covers core Horae and event fields; merely wiring up that prompt is \*\*not sufficient\*\* to claim HP, skills, or equipment are supported.

\- Keep the new background-analysis prompt separate from the legacy prompt that tells the \*\*main\*\* model to emit tags. Do not overwrite or damage legacy default templates. Create separate background-mode templates/settings or carefully selected branches as needed.

\- Updates must be \*\*incremental\*\*: unchanged stats, items, and skills must not be registered again; unknown information must not be invented. Consider both the user's immediately preceding established action and the completed AI response.

\- Extract \*\*established facts\*\*, not suggestions, conditional possibilities, hypothetical outcomes, or actions the user has not taken. Tracking must not grant the narrative model extra authority to decide the player's actions.



\## 4. Functional Requirements (Prioritized)



\### P0-A: Introduce Two Modes; Preserve Legacy Compatibility



Provide an explicit, visible, persistent mode selector, e.g.:



\- `Legacy / Inline Tags`: Existing behavior; preserve it as closely as possible.

\- `Background / Metadata Only`: The target mode for this fork.



The new mode should be easy to enable. For a \*\*fresh installation of this fork\*\*, defaulting to Metadata Only is recommended, but do not silently or irreversibly alter the settings of an existing installation. Switching modes must \*\*not\*\* erase state. The selected mode and its settings must survive an ST refresh/restart.



\### P0-B: In Metadata Only Mode, the Main Model Must \*\*Never Be Instructed\*\* to Emit Horae Tags



Audit all prompt-building and injection paths, including:



\- `onPromptReady()`.

\- `horaeManager.generateSystemPromptAddition()`.

\- `horaeManager.generateCompactPrompt()`.

\- RPG, location, relationship, mood, timeline, and vector-recall prompt additions.

\- Legacy instructions requiring `time`, `location`, `characters`, `costume`, `event`, etc. every turn.

\- Additional generation/completion entry points triggered by UI editing or state repair.



Requirements:



1\. \*\*Keep factual state injection\*\*, such as current HP, skills, held items, relationships, and location. The GM must still know the latest world state.

2\. \*\*Remove every instruction aimed at the main GM/model to produce or repair\*\* `<horae>`, `<horaeevent>`, `<horaerpg>`, `time:`, `skill:`, etc. This applies not only to the system prompt but also to snapshot wording such as “output changed fields inside `<horae>`.” Replace these with read-only state descriptions.

3\. Do not rely solely on the user removing instructions from their GM card, post-generation regex cleanup, or increasingly elaborate negative prompt rules.

4\. Background analysis must not trigger another \*\*normal narrative GM generation\*\*, nor accidentally append private analysis messages to shared group-chat history.

5\. Preserve the legacy regex/hiding implementation. In Metadata Only mode, however, \*\*correctness must not depend on those regexes\*\*.



\### P0-C: Automatically Analyze Completed Messages and Persist Full State



When a \*\*genuinely completed\*\* AI narrative message becomes available:



1\. Read its ordinary prose, the appropriate preceding USER action, the reliable state immediately \*\*before\*\* that message, and limited additional context if necessary.

2\. Generate a state delta asynchronously through the existing auxiliary API pipeline. Honor current endpoint/model/authentication settings, timeout behavior, and error handling. If the auxiliary API is missing or fails, show a clear failure; \*\*never\*\* claim success or silently write guessed state. Follow the user's existing explicit setting for whether fallback to the main API is allowed.

3\. Strictly parse the private result. \*\*Never\*\* apply `parseLooseFormat()` to ordinary narrative prose to derive state in this mode. Support an explicit, legitimate “no changes” outcome.

4\. Persist validated deltas in \*\*that message's\*\* `horae\_meta`. Reuse or extract shared helpers from `mergeParsedToMeta()` and existing RPG, relationship, location, table, and agenda update paths rather than reimplementing game semantics.

5\. Update necessary `chat\[0]` aggregates, persist the chat, refresh the UI, and update the relevant vector index entries using existing mechanisms.

6\. If nothing changed, mark that message as \*\*analyzed successfully with no changes\*\*. \*\*Never invent a new time, outfit, or affection score every turn\*\* just to populate fields.

7\. Each AI-message version may have \*\*at most one effective state commit\*\*. Duplicate events, page rerenders, retries, or concurrent callbacks must not duplicate inventory acquisitions, damage, or timeline events.



\*\*Do not consider the task complete by simply calling `analyzeMessageWithAI()` inside `CHARACTER\_MESSAGE\_RENDERED`.\*\* Guard against duplicate events, rerendered history, concurrency, chat switches, and swipe transitions.



\### P0-D: Eliminate All Metadata-to-Prose Writeback in the New Mode



Under Metadata Only, \*\*no automatic state operation or UI edit may mutate `chat\[i].mes` merely to serialize state\*\*:



\- Audit all callers of `injectHoraeTagToMessage()` and adapt them.

\- Audit RPG HUD edit paths that append `<horaerpg>` to `mes`; upstream also contains direct assignments of the form `message.mes = mes`.

\- Audit AI completion of a previous message, manual NPC/relationship/item/timeline edits, summary edits, automatic repair flows, and their common helpers.

\- Look for other tag-append, DOM/regex, or string-replacement paths that modify narrative message content.



\*\*Do not merely turn the writeback function into a no-op.\*\* Existing UI editing and rebuild functions may depend on embedded tags as a persistence source. Update each affected operation to change metadata directly, then verify that its changes survive saving, reloading, and rebuilding.



Preserve the original byte content of `mes` by default. Do not silently strip genuine plot text, deliberately user-supplied content, or legitimate discussion of tags. If legacy sanitization routines rewrite `mes`, avoid unnecessary text mutation in the new mode.



\### P0-E: Keep State Consistent With Chat Edits and Generation Lifecycle



\- \*\*New response:\*\* Detect once; commit successfully once.

\- \*\*Regenerate / swipe change:\*\* State from the superseded AI response must stop applying. Analyze the new selected version and rebuild dependent aggregates.

\- \*\*Message edit:\*\* Reanalyze the edited content; \*\*replace\*\* that message's old delta instead of stacking another one. Rebuild aggregates.

\- \*\*Message deletion:\*\* Revoke its delta and restore correct state using existing rebuild facilities.

\- \*\*Save and reload:\*\* Persist state. Rerendering historical messages must not trigger a wave of new auxiliary requests.

\- \*\*Manual UI edits:\*\* Retain existing field editing/deletion and NPC, relationship, RPG HUD, and timeline controls, without rewriting prose.

\- \*\*Multiple AI messages / group chat:\*\* GM and independent character cards generating in the same chat must update one shared world state correctly; two consecutive AI messages must not count the same USER action twice.

\- \*\*Async results after switching chats:\*\* A task started for chat A must \*\*never\*\* write into chat B. Capture `chatId`/`groupId`, target-message identity, selected swipe/version, and a fingerprint of the original prose. Validate all of them again before commit; discard stale results.

\- \*\*Ordering:\*\* Apply state changes for the same chat in narrative/message order. The next normal generation should see the committed previous-turn state. Use a safe queue/wait mechanism for outstanding background work, without deadlocks or recursively invoking model generation.



Persist a verifiable \*\*analyzed marker and corresponding prose/swipe-version fingerprint\*\*. The existence of `horae\_meta` alone is not enough: “analyzed, no state changes” is also a successful result.



\### P1: Existing UI, Vector Memory, and Other Subsystems Must Remain Compatible



\- Existing character, relationship, affection, inventory, timeline, RPG HUD, skill, attribute, equipment, level, currency, stronghold, location-memory, and manual-edit interfaces must keep reading \*\*the original state format\*\*.

\- Keep Horae's own `vectorManager` and its metadata-driven vector documents; vector indexing should not require inline tags in `mes`. Build/update index entries after background metadata commits; synchronize old entries on edit/delete. Existing `generateRecallPrompt()` must still supply relevant history when normal generation needs it.

\- Keep the \*\*code\*\* for automatic summarization, auto-hide, and every unrelated subsystem; preserve each user's chosen settings. Do not enable, rewrite, or fix unrelated historical behavior as part of this task. However, when Metadata Only mode is selected, such features must \*\*not indirectly reinsert state tags into `mes`\*\*.

\- Preserve interoperability among manual UI edits, existing extension APIs, and both modes' state representation. Do not allow the two modes to parse/commit the same response twice.

\- Do not force ST's built-in vector extension or any additional summarization plugin. The user specifically wants to keep \*\*Horae's\*\* vector engine.



\### P1: Background Request Configuration and Observability



\- Prefer Horae's existing Auxiliary API settings and `\_generateForAuxTask()`. Do not require new prompt directives in the GM card.

\- Prefer an independent enable/disable switch for \*\*automatic background state analysis\*\*, relevant only when Metadata Only mode is active.

\- Show concise, visible status such as \*\*Synced\*\*, \*\*Analyzing\*\*, or \*\*Analysis failed / Retry\*\*. Logs should identify the target message and failure reason, but \*\*never expose API keys or dump private analysis text into the chat\*\*.

\- Provide a way to \*\*manually reanalyze\*\* a failed or missed message, preferably by reusing an existing magic-wand / AI-analysis UI action.

\- Empty responses, invalid data, and API failures must leave prior valid state untouched and remain retryable. Do not partially corrupt `chat\[0]` aggregates.

\- Avoid needless API calls by reusing content fingerprints and completed-analysis markers.



\## 5. Existing Code Couplings That Require Careful Review



The following names/locations were confirmed in upstream `1.15.1`; re-check them in the actual fork before editing:



| File / Function | Existing role | Required behavior in Metadata Only |

|---|---|---|

| `index.js: onPromptReady()` | Injects state, instructions, vector recall, and some pre-send completion work | Keep factual state and recall; remove main-model tag-generation directives; inspect pre-send routines for prose writeback |

| `core/horaeManager.js: generateSystemPromptAddition()` | Builds rules for the main model | Do not inject mandatory tag-output instructions |

| `core/horaeManager.js: generateCompactPrompt()` | Builds current-state snapshot | Remove “please output Horae fields” language; keep factual state |

| `index.js: analyzeMessageWithAI()` | Existing independent AI analysis | Reuse as the background analyzer; include all required RPG fields |

| `index.js: \_generateForAuxTask()` | Auxiliary API routing and execution | Reuse while preserving isolation, concurrency safety, and fallback settings |

| `core/horaeManager.js: parseHoraeTag()` | Parses structured tags | Parse \*\*private auxiliary responses\*\*, not tags in the main narrative |

| `core/horaeManager.js: processAIResponse()` | Parses prose, then merges metadata | Separate “parse raw text” from “apply parsed delta,” or extract common helpers; avoid normal-prose parsing/loose fallback |

| `core/horaeManager.js: mergeParsedToMeta()` | Merges message-level state | Preserve/reuse |

| `core/horaeManager.js: \_mergeRpgData()` / `rebuildRpgData()` | RPG aggregation and replay | Preserve/reuse; adapt edit/rollback sources as necessary |

| `core/horaeManager.js: getLatestState()` / `getRpgStateAt()` | Reads state at a message boundary | Preserve semantics based on per-message deltas |

| `index.js: onMessageReceived()` | Watches and parses AI replies | Implement reliable background scheduling and commits for the new mode |

| `index.js: onMessageEdited()` / `onSwipePanel()` / `onMessageDeleted()` | Edit, swipe, delete handling | Reanalyze/revoke appropriate deltas and rebuild while honoring manual edits |

| `index.js: injectHoraeTagToMessage()` | Serializes metadata back into `mes` | Never write to prose in the new mode; update dependent callers individually |

| `index.js: RPG HUD tag-writeback helpers` | Append `<horaerpg>` inside `mes` | Persist directly to metadata without losing manual HUD changes |

| `index.js: ensureRegexRules()` | Installs hide-tag regexes | Preserve legacy support; new mode must not rely on them |

| `core/vectorManager.js` | Vector documents/indexing/recall | Preserve; ensure background commits trigger appropriate updates |

| `prompts/\*` | Localized default prompt templates | Preserve legacy templates; add background-specific templates/branches if needed |



\*\*Important:\*\* `index.js` is very large, and many UI handlers indirectly call tag-writeback functions. Modifying only `onMessageReceived()` and `onPromptReady()` is \*\*not enough\*\*.



\## 6. Recommended Implementation Order (Avoid a Broad Rewrite)



1\. \*\*Audit and plan:\*\* Map the state lifecycle, all `mes` mutation sites, analyzer entry points, prompts, and dependencies on legacy behavior. Produce a short implementation plan.

2\. \*\*Mode selection:\*\* Add the `Legacy` / `Metadata Only` branch without changing legacy behavior. Establish baseline tests if practical.

3\. \*\*Read-only state injection:\*\* In Metadata Only mode, ensure the GM receives no instruction to output tags while still receiving current state and vector recall.

4\. \*\*Background delta extraction and commit:\*\* Completed narrative → auxiliary AI → parser → existing merge semantics → metadata. Never mutate `mes`.

5\. \*\*Decouple UI writebacks:\*\* Fix manual editing, HUD, relationships, items, timeline, pre-send completion, etc., wherever they currently depend on inline tags.

6\. \*\*Edit/swipe/delete and async correctness:\*\* Add retries, deduplication, stale-result rejection, and deterministic state rebuilds.

7\. \*\*Tests and documentation:\*\* Exercise the acceptance scenarios and provide minimal setup instructions, including which old Horae-output rules can be removed from the GM card.



Extracting shared helpers or splitting files is acceptable where genuinely necessary. The goal is the \*\*smallest reliable architectural change\*\*, not a wholesale UI/data-model refactor.



\## 7. Mandatory Acceptance Tests



The following should pass in a real ST installation or a sufficiently accurate simulation of its lifecycle/events, with automated unit tests where useful. For \*\*every\*\* scenario, verify not just the visible UI but also `message.mes`, per-message metadata, aggregate RPG state, and persistence after reload.



1\. \*\*Clean narrative:\*\* The GM produces a normal 800–1,200-character Chinese story response. No auto-generated `<horae>`, `time:`, `skill:`, or similar state dump appears, \*\*even with Horae's hiding regexes disabled\*\*. Background analysis never appends data to the raw `message.mes`.

2\. \*\*HP changes:\*\* Start with `尤丝蒂娜 HP=96/100`; explicitly lose 12 HP in one turn → HP becomes 84. A dialogue-only turn does not deal damage again; the correct state persists.

3\. \*\*Skill acquisition / upgrade:\*\* Acquire skill A; later upgrade it; retain detailed effects. Ten unchanged turns preserve it without duplicate registration. Manual edit/delete still works.

4\. \*\*Inventory operations:\*\* Pick up a badge, move it to a bag, equip an existing item, hand an item to an NPC, and lose an item. Correctly update name, holder, location, quantity, and related properties without duplicate acquisition.

5\. \*\*Characters and relationships:\*\* Register a new NPC and update appearance, relationship, and affection. Mentioning an NPC without changes must not overwrite previously recorded facts.

6\. \*\*Scene and story time:\*\* Change location, in-story date, and present characters; verify UI and next-turn injection. Story time must never be replaced with wall-clock time; idle dialogue need not advance the date.

7\. \*\*Event timeline:\*\* Meaningful story events enter the timeline; trivial turns may add no event. Never append an event tag to prose.

8\. \*\*No-change turn:\*\* A dialogue with no stat, item, or relationship changes is recorded as \*\*analyzed, no changes\*\*, with no invented data and no repeated API requests.

9\. \*\*Auxiliary API failure:\*\* Missing key, timeout, or malformed response leaves prose intact and previously valid state untouched; failure is visible and retryable.

10\. \*\*Page reload:\*\* State, manual UI edits, and analysis markers survive. Rendering historical messages does not trigger large numbers of analyses.

11\. \*\*Swipe / regenerate:\*\* An old response causes damage, but the selected new swipe does not. HP rolls back correctly, and any late response from the superseded analysis cannot corrupt state.

12\. \*\*Edit / delete an older message:\*\* Rebuild later state correctly, without duplicate items/skills, lost manual changes, or dangling timeline events.

13\. \*\*Immediate next turn:\*\* The user starts the next GM generation immediately after the prior response. Ordering is correct: the new turn does not act on stale HP/inventory, and no deadlock occurs.

14\. \*\*Chat switching:\*\* An auxiliary request started in chat A finishes after switching to B. It must never write any result into B.

15\. \*\*ST group chat:\*\* GM and independently controlled character cards alternate replies while maintaining one shared world state. Do not count a single USER action twice.

16\. \*\*Direct HUD editing:\*\* Editing HP, skills, relationships, or inventory through the UI persists immediately and is visible next turn. `mes` remains \*\*completely unchanged\*\*, including after reload/rebuild.

17\. \*\*Vector memory:\*\* Build/update the index from generated metadata and recall earlier facts by relevant narrative keywords. Inline Horae tags must not be necessary.

18\. \*\*Legacy compatibility:\*\* Switching to Legacy preserves existing tag parsing, UI, prompts, and optional auto-summary/hide behavior without material regression.

19\. \*\*Unrelated features remain intact:\*\* Preserve the user's auto-summary toggle; do not force it on when installing the fork. Character, relationships, RPG, quests, and other panels/buttons remain accessible and functional.

20\. \*\*Verifiable model separation:\*\* Inspect the actual request sent to the main model: it includes factual state, \*\*not\*\* a requirement to generate `<horae>`. Inspect the auxiliary prompt/response: its data remains strictly internal and never appears as group-chat messages.



\## 8. Deliverables



Deliver the following \*\*in the current working directory\*\*:



1\. \*\*Runnable modified fork code\*\*, not merely a proposed architecture or pseudocode.

2\. \*\*Concise change summary:\*\* New modes/settings, key source changes, and how existing functionality was preserved.

3\. \*\*Installation and usage instructions:\*\* Install the user's fork, select Metadata Only, configure the existing Auxiliary API, leave auto-summary off if unwanted, and perform a minimal smoke test.

4\. \*\*GM prompt cleanup guide:\*\* Explain that, in the new mode, the GM character card should remove instructions to output `<horae>`, `<horaerpg>`, `<horaeevent>`, and custom status-sync formats such as `\[获得物品]`. The GM's narrative control, Fate lore, and Servant-tool instructions do \*\*not\*\* need a rewrite.

5\. \*\*Test report:\*\* Which automated and manual checks were run, their results, and which could not be executed (with reasons). Do not claim unperformed tests passed.

6\. \*\*Known risks / incomplete work:\*\* If some existing UI edit or legacy path cannot safely be adapted immediately, identify it explicitly rather than silently dropping state. Prioritize completion of P0 issues.



\## 9. Single Core Definition of Success



> The user can continue using Horae's existing character, skill, inventory, relationship, HP, timeline, and vector-memory interfaces, with those records updating automatically as the story unfolds. Meanwhile the GM and other character cards produce \*\*only narrative text\*\*: they never need to know or emit Horae's recording syntax. All state changes are derived by independent background analysis and saved directly to metadata. An analysis or parsing failure must never contaminate the story visible to the player.



\*\*Do not substitute “add another GM instruction,” “strengthen the hiding regex,” or “periodically scrub the narrative text” for this architectural change.\*\*

