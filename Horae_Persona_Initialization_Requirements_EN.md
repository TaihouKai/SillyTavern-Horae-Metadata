# Deterministic Persona Initialization for the Horae Metadata Fork

Implementation brief for Claude Code. Prepared 2026-10-13, Asia/Tokyo.

## 1. Task and intended result

Implement a reliable, opt-in Persona starting-state feature in the owner's existing Horae fork:

- Target: https://github.com/TaihouKai/SillyTavern-Horae-Metadata
- Compatibility target, unchanged in v1: https://github.com/Maxwell5600/Persona-Library
- Host: the owner's installed SillyTavern version; inspect it before selecting lifecycle hooks or persistence APIs.

The owner uses a non-embodied GM character card. The real player character is the active SillyTavern Persona, edited and switched through Persona Library. Horae records the RPG state. Currently the GM is instructed to copy Persona skills, possessions, and a stronghold at the start, but the registration is unreliable. HP/MP/SP bars usually fail, skills sometimes succeed, and inventory usually fails.

The desired experience is:

1. Select a Persona.
2. Open a Horae panel for that Persona's starting profile.
3. Enable “Use this starting profile in new chats.”
4. Configure named resource bars and their actual initial values, skills with full descriptions, possessions with full descriptions, and strongholds.
5. Start a new chat and request the first scene.
6. Horae initializes those values once, before the first actual story-generation request sees its state snapshot. The GM can write a normal opening scene without reciting an inventory or emitting state tags.
7. All later state is the starting baseline plus the changes recorded during that chat. Nothing automatically refills, respawns, or resets when the page reloads or a response is regenerated.

The owner asked for this brief, not for code changes during the investigation. No plugin code or remote repository was modified by the investigator. This document is the handoff for subsequent implementation.

## 2. Evidence and diagnosis

### 2.1 Audited versions

The findings below are grounded in these exact repository commits, not just their README descriptions:

| Repository | Audited commit | Manifest version |
|---|---|---|
| Horae Metadata fork | `221e30415c0a3fb2162f699917c71829f36d959c` | `1.15.1` |
| Persona Library | `b1cc092556fa2879b227c2706b2ccefb0cee9304` | `1.8.0` |

Re-check the implementation if the working branches have moved. Do not revert newer work to match these commits.

The investigator did not access the owner's running SillyTavern, extension settings, Persona text, failing message metadata, or actual model request logs. Therefore the code-level findings are confirmed, but attributing every observed failed opening to one cause is not possible. In particular, confirm `stateMode`: this fork defaults fresh installs to `metadata`, but preserves existing installs as `legacy` during migration.

### 2.2 Main architectural gap: the background analyzer does not receive the Persona

In `index.js`, `_bgBuildPrompt()` constructs the analyzer input from:

- Horae's state snapshot before the target reply;
- the preceding USER action, if found;
- the completed AI reply;
- format instructions for enabled modules;
- user/character/speaker names.

It does not include the Persona description, Persona Library Sections or Variants, or the GM card's initialization instructions. `_bgFindUserAction()` also limits the preceding USER text to 2,000 characters; pasting a very large starting sheet into one user message is therefore not a reliable substitute.

`_getAuxApiPromptProfile('analysis')` sets `skipOaiInjection: true`. The background request uses `forceRaw: true` and disables Horae context reinjection for that internal request. The analyzer does not inherit the GM's normal full prompt merely because both requests use the same model or API account.

The default analyzer prompt explicitly says to record established changes only and not invent missing stats. Consequently:

- A skill that the first scene happens to describe may be extracted.
- A possession mentioned in Persona but absent from the reply is unavailable to this request.
- A bar definition such as “HP” does not establish an actual `current/max` value for the player.
- Requiring the GM to “initialize everything” does not itself execute any persistence operation.

This is the primary explanation for inconsistent registration in Metadata mode. It is a missing deterministic initialization path, not evidence that Persona Library randomly loses all Persona data.

### 2.3 The current GM prompt contains incompatible responsibilities

The supplied opening requests initialization of `# 技能`, `# 物品`, and `# 据点`, but does not define explicit HP/MP/SP starting numbers. Its main prompt also requires custom status lines such as:

```text
[获得物品: XX]
[习得技能: XX; 技能描述: XX]
```

These are not Horae's native parser commands. Both `parseHoraeTag()` and `parseLooseFormat()` returned `null` for an isolated example containing these two lines. In Metadata mode the background LLM could interpret them as text, but that is another inference step, not a guaranteed registration API. In Legacy mode they also do not replace valid `<horae>` / `<horaerpg>` data.

The fork's own `docs/METADATA_MODE.md` already instructs users to remove custom state-dump requirements, including `[获得物品…]`, from the GM prompt. Horae injects a prose-only instruction for the main model in Metadata mode. The current prompt is therefore asking the main model to do work this fork intentionally moved out of its output.

Also, “record only this turn's changes” and “copy all possessions the player already had before the story” are different operations. Starting ownership should be entered as a baseline, not fabricated as an acquisition event in the first scene.

### 2.4 Persona Library's role

At the audited revision:

- `composeDescription()` combines the core description and enabled Sections into text.
- `savePersonaSections()` writes the composed text to native Persona storage and updates the active singular `power_user.persona_description` field.
- Variants temporarily modify the effective Persona text during generation and restore it afterward.
- `getActiveId()` reads the actual `user_avatar` export from SillyTavern.
- There is no Horae initialization or state-writing integration in the inspected Persona Library source.

The current Persona Library version already contains a fix for saving only the per-Persona dictionary while failing to update the active singular description field. Check the installed revision before assuming an old version has that fix. No evidence from the audited version establishes Persona Library as the main cause here.

If a future import helper reads effective Persona prose after generation ends, dynamic Variants may already have been restored. Do not build the initializer around timing a read of this temporary text. Explicit structured profiles avoid that dependency.

### 2.5 Confirmed Horae state/display issues relevant to initialization

**Aggregate-only writes are insufficient.** RPG history is reconstructed from `_rpgChanges` and selected manually preserved data. Writing only `chat[0].horae_meta.rpg.bars` does not make that HP visible through `getRpgStateAt()`, and `rebuildRpgData()` clears it when there is no replayable source. Treat `rpg` as an aggregate/cache, not the sole authority for initial state.

**The bulk HUD path skips message zero.** `_buildRpgSnapshotMap()` starts bars and skills empty, then processes a message's RPG changes only under `if (changes && i > 0)`. `getRpgStateAt()` and `rebuildRpgData()` do replay message-zero changes. An initial HP change at index 0 therefore appears in the manager snapshot and disappears from the bulk HUD snapshot. This was reproduced with the original functions. It is a confirmed defect in the audited fork, but it has not been proven to be the cause of the owner's particular sessions.

**Recorded and visible are separate conditions.** `renderRpgHud()` requires RPG/bars to be enabled and a nonempty, matched present-character list. The Metadata fallback carries forward a prior present list, but does not help if the player was never recorded there. `generateCompactPrompt()` also filters RPG output by present characters and `rpgStrictPresentOnly`. A correct initializer must address visibility without inventing NPCs or a starting scene.

**Bar configuration is not player state.** `rpgBarConfig` defines bar names and metadata. It is not a per-player starting-value store. Existing module switches also gate format instructions, snapshots, and display.

### 2.6 Verification actually performed

An isolated Node harness imported the downloaded, unchanged Horae manager and used the original index functions extracted into a minimal harness. It verified:

| Check | Result |
|---|---|
| Custom Chinese bracket markers | Both native strict and loose parsers returned `null`. |
| Valid Horae tags containing HP, one skill, and one item | All three were stored and readable. |
| HP written only to the aggregate `rpg.bars` | Missing from historical snapshot; lost on rebuild. |
| HP in message-zero `_rpgChanges` | Manager returned `100/100`; bulk HUD snapshot returned no HP. |
| Background prompt builder with sentinel inputs | Included state, user action, reply and module text; omitted Persona description. |

These are targeted code-level checks. They are not browser E2E tests, live API tests, or a reproduction of the owner's exact configuration.

## 3. Architecture decision

### 3.1 Implement v1 inside Horae

Store and edit Persona starting profiles in Horae, keyed to native SillyTavern Persona identity. Persona Library continues to manage the same native Personas and does not need a fork.

This keeps the state owner, persistence, replay, and display logic together. It avoids making Persona Library write private Horae internals or introducing a second dependency whose update cycle must be maintained.

| Approach | Assessment |
|---|---|
| Strengthen the GM prompt alone | May improve compliance; cannot guarantee initialization or give the background analyzer information it never receives. |
| Send Persona prose to the analyzer | Useful for a reviewed import assistant; still nondeterministic and risks repeatedly restoring starting possessions. |
| Modify Persona Library to write Horae state directly | Feasible, but couples two forks and still requires correct Horae replay/persistence changes. |
| Structured starting profiles and bootstrap owned by Horae | Required v1 approach. Deterministic, one maintained fork, compatible with native Personas and Persona Library. |

### 3.2 Separate three kinds of data

1. **Reusable template:** editable across chats; belongs to a Persona profile.
2. **Chat baseline:** a frozen copy of that template, committed once for this chat.
3. **Story deltas:** ordinary per-message changes applied after the baseline.

The resulting state is:

```text
state at a story boundary = fold(chat baseline, valid story deltas up to that boundary)
```

Reading/rebuilding the baseline repeatedly is correct. Reapplying starting values over later deltas, or reissuing items as new acquisitions, is incorrect.

Do not continually synchronize current state back into the reusable starting template. Do not continuously overwrite chat state from the template.

### 3.3 Keep v1 bounded

Do not fork Persona Library, change SillyTavern core, add a server component, rewrite Horae's entire RPG system, add a world simulator, or introduce a full multi-player identity engine for this task.

Do not add a recurring LLM request for initialization. The normal path must work with the API disconnected up to the point of requesting the actual story.

The current Horae port/provider API is a display/data-provider interface; it is not an existing transactional state-import API. Do not mistake registering a provider for persisting an RPG baseline.

If a Persona Library editor is desired later, it should be a thin client of a versioned Horae service. That is a separate optional phase, not a reason to require a second fork now.

## 4. User interface and template requirements

### 4.1 Persona profile editor

Add a clear entry in Horae's existing UI, e.g. “Persona starting state / Persona 开局状态”. It must:

- Show the target Persona's name and avatar, and identify the currently active Persona.
- Resolve Personas from SillyTavern data, not scraped HTML, Persona names alone, or a hardcoded Persona Library install path.
- Have an opt-in checkbox: “Use this profile to initialize new chats”. Default off for unconfigured Personas.
- Provide expandable editors for bars, skills, inventory, and strongholds.
- Provide Save, a structured preview/validation result, and JSON export/import for the template.
- Show current chat status: no profile, ready for next new chat, initialized, inherited, not eligible, prerequisites missing, or failed with a useful reason.
- Make clear that editing a template changes future new chats, not the current campaign.

Use normal SillyTavern styling and existing Horae localization conventions. Avoid a separate application or heavy UI framework.

A small “save current state as a new template” convenience is optional; it must not be automatic or necessary for v1.

### 4.2 Resource bars

Each bar needs:

- Stable machine key, such as `hp`, `mp`, `sp`, or `mana`.
- Display name, such as 生命、魔力、体力.
- Optional description and color.
- Initial current value and initial maximum value.

Use finite nonnegative integers in v1 to match the current parser's supported values. Require maximum greater than zero and current no greater than maximum. Preserve zero as a valid current value; never use a truthy fallback that turns `0` into “full”.

Normalize keys consistently with the existing engine. Reject duplicate keys, reserved protocol keys, unsafe object keys, invalid numbers, and values the runtime cannot round-trip. Do not silently clamp an invalid template without showing the user.

Providing a visible preset for `HP 100/100`, `MP 100/100`, and `SP 100/100` is acceptable. Saving/choosing it constitutes the explicit configuration. Do not infer exact numbers from prose such as “healthy” or from a Toaru Level 5 classification.

Bar definitions for a saved template must be snapshotted for the chat. Selecting another Persona must not silently overwrite global `rpgBarConfig` and change existing campaigns. Introduce a small effective-configuration resolver with chat definitions taking precedence and existing global definitions as fallback; use it consistently for display and prompt generation.

### 4.3 Skills

Each skill needs a name and full description, plus an optional level/proficiency label. Preserve all text, multiline formatting, limitations, and source information the user entered. Blank level is allowed. Do not invent levels or summarize descriptions during import.

The native RPG format uses `desc` for the description; convert through one explicit adapter. Do not serialize user text into a `skill:...|...` string and parse it back: descriptions may legitimately contain pipes, equals signs, line breaks, or tag-like text.

Validate duplicate skill names within a profile, because the current merge identity is effectively owner plus skill name.

### 4.4 Possessions

Use Horae's normal item system for every holdable object, including weapons, clothing, jewelry, and equipment. The owner explicitly does not want the separate RPG equipment system used for these possessions.

Each item needs:

- Name and full description.
- Quantity, default 1, with an optional unit if supported by the existing item model.
- Holder: default to this chat's player identity; optionally an explicitly named holder.
- Optional initial location such as a bag or a room.
- Optional icon and importance.

Do not invent a physical location when none was configured. An empty/unknown location is preferable to inventing a pocket or moving the player.

Adapt quantity to the current item's name/base-name representation deliberately. Reuse its identity rules rather than adding a second incompatible inventory model. Reject ambiguous duplicates that the existing dictionary/base-name merger cannot distinguish; do not silently merge two distinct named possessions or overwrite descriptions.

Seeded items are starting ownership, not newly acquired first-turn loot. Later consumption, transfer, loss, and deletion must take precedence. A removed item must not reappear on refresh.

### 4.5 Strongholds

Include starting strongholds because they are part of the supplied initialization goal. Support name, full description, optional level, and parent/child structure where Horae already supports it. Generate or validate stable node IDs; reject invalid parent references and cycles.

Owning a base does not establish the current scene location or teleport the player there. Do not create narrative events merely to register it.

### 4.6 Importing existing Persona text

A text-to-profile import assistant is optional, not part of the correctness path. Manual structured entry and JSON import are sufficient for v1.

If implemented later, it must produce a reviewable draft, preserve explicit descriptions, flag unknown numbers, and never apply state silently. Do not promise reliable extraction of arbitrary Markdown, Additional Sections wrappers, or dynamic Variants with a few regexes. Do not make the initializer depend on headings spelled exactly `# 技能`, `# 物品`, or `# 据点`.

## 5. Identity and persistence

### 5.1 Persona identity

Use the native Persona avatar/storage key as the binding key, following the actual installed host API/module exports. Persona Library's `getActiveId()` is a useful reference; do not assume `getContext().user_avatar` exists.

- Two Personas with the same display name must still have separate templates.
- Renaming the display name must not lose the template.
- Replacing the image while retaining its native key must not lose the template.
- Duplicating a Persona must not accidentally share one mutable template object. Offer explicit copy/import; automatic duplication support is optional.
- Deleting a Persona must not erase the frozen baseline of an existing campaign.

At initialization, capture both the stable Persona key and the resolved player name used by Horae. Never seed under the GM card name or leave `{{user}}` as a runtime owner string that will resolve to a different Persona later.

Changing the active Persona in an initialized chat must not initialize again, transfer the original player's items, or reinterpret old records as belonging to the new Persona. Keep the captured owner and show an identity mismatch indicator. Full automatic historical renaming/multi-PC migration is outside v1; document the supported behavior.

### 5.2 Template storage

Use a namespaced Horae-owned extension-settings record for reusable templates, with a schema version and per-profile revision. Include it in an intentional template export/import workflow. Do not store runtime campaign HP in the reusable template, overwrite Persona descriptions, or store API credentials in exports.

### 5.3 Chat baseline storage

Prefer a namespaced chat-metadata record containing both the committed baseline and its initialization marker. Verify the exact host field and persistence method on the installed SillyTavern version. A suggested name is `horaePersonaBootstrap`; this is a proposed new field, not an existing API.

The logical record should retain:

- Schema version and applied/inherited status.
- Source Persona key, captured owner name, template/profile ID and revision.
- A frozen copy of the initial bars, skills, inventory, strongholds, and relevant bar definitions.
- A local commit identifier or equivalent for idempotence and diagnostics.
- The applicable story boundary: before the first story for automatic bootstrap; a current boundary for an explicitly approved later repair.

If project constraints instead require a protected field on `chat[0].horae_meta`, prove that the baseline and marker survive deletion/replacement of that message, greeting swipes, reanalysis, imports, and carryover. An ordinary `_rpgChanges` record on the greeting does not satisfy this requirement.

Do not create a visible fake message or hide a synthetic `<horaerpg>` payload in prose just to provide storage. Metadata mode's `message.mes` must remain byte-identical.

## 6. Initialization lifecycle: what “only the first message” means

### 6.1 Trigger and eligibility

“Once” means once per genuinely new chat/campaign baseline, before the first real narrative generation builds its Horae snapshot. It does not mean “whenever `chat.length === 1`”, “once per page load”, or “once per Persona forever”.

Initialize only when:

1. Horae and the selected starting profile are enabled.
2. The chat is eligible as a fresh campaign.
3. There is no committed baseline/initialization marker and no inherited campaign state.
4. The template validates and the native Persona is resolved.
5. The request is an actual narrative request, not a dry run, token count, background analysis, vector query rewrite, summary, enrichment, impersonation, or other auxiliary generation.

Inspect the installed host's generation event order. Use an awaited, supported preflight before Horae's own state snapshot is generated. The existing `onPromptReady()` and generation event handlers are investigation points, not proof that every provider and generation type can use the same event.

Do not initialize after the reply finishes: the first story would already have been generated with incomplete state. Do not rely on a timeout, polling the DOM, or extension loading order alone.

Greeting messages, multiple greeting variants, empty greetings, and a user pressing “Start” are not sufficient reasons to classify a chat as already played. Conversely, opening an old transcript with no Horae metadata is not permission to treat it as new. Use actual lifecycle/provenance and conservative checks. If freshness cannot be established, expose a manual action rather than overwriting an old campaign.

### 6.2 Commit semantics

- Validate the entire profile before mutating state.
- Capture chat identity and Persona identity before asynchronous work; revalidate immediately before commit.
- Serialize initialization attempts for the same chat. Duplicate hooks must converge on the same result.
- Commit baseline and initialization marker together through the host's correct save path.
- Build the main-model snapshot from the committed baseline.
- On save failure, retain a retryable failure, do not report success, and do not leave a partial item/skill list or a success marker without data.
- If initialization succeeded but story generation was canceled or failed, retain the committed baseline. The retry must reuse it without issuing more items.
- If the chat changes while a preflight is awaiting something, never apply the old profile to the newly selected chat.

Zero, empty inventories, and removed skills can all be legitimate later states. Never use missing/empty current bars or items as the sole signal to initialize again.

### 6.3 Switches and errors

Display the prerequisites for this profile, including RPG mode and the relevant bars/skills/stronghold modules, plus item/context injection where needed. Offer an explicit, convenient way to enable required existing switches while configuring the profile. Do not silently change unrelated settings or pretend the initialization failed solely because a display was hidden.

An enabled profile with invalid data or missing prerequisites must produce a clear, retryable preflight result. Do not quietly send the first story with half the promised state and mark the chat initialized. Use the host's supported cancellation/error handling when necessary.

Do not force users to reapprove a valid saved profile every time they open a new chat. The opt-in profile is the authorization for automatic fresh-chat initialization.

## 7. Replay, display, and analyzer integration

### 7.1 One state interpretation

Integrate the baseline into every relevant state reader/rebuilder:

- `getLatestState()` for inventory and other ordinary state;
- `getRpgStateAt()` for time-bounded RPG snapshots;
- `rebuildRpgData()` for aggregate rebuilds;
- `_buildRpgSnapshotMap()` for batch HUD snapshots;
- `generateCompactPrompt()` for main and analyzer state;
- current-chat drawer/HUD rendering and exports.

Prefer a small shared pure fold/apply helper over four separate implementations of baseline precedence. Avoid a broad refactor unrelated to these semantics.

Apply baseline first, then replay the current versions of story deltas in order. Apply current manual edits and deletion rules at their proper points. Never overlay the initial HP, skill level, or item count over a later mutation.

Do not mark every seed entry as permanently `_userAdded` or locked merely to survive rebuilds. Those mechanisms can conflict with legitimate later loss/removal and are not a substitute for a baseline.

### 7.2 Fix the message-zero discrepancy

Remove the unconditional omission of message-zero RPG changes in the bulk HUD path, while preventing double application of the new baseline. Also audit `getRpgStateAt()`'s `Math.max(1, ...)`: asking for state before the first AI message must not include that message's future delta. It should still include a legitimate pre-story baseline.

Use the same timeline semantics in direct snapshots, batch snapshots, and rebuilds. A pure “baseline plus deltas” model should make this behavior explicit.

### 7.3 Player visibility

The initial player sheet must be visible and available to the main model even before the first scene has established a cast list. Do not seed fake NPCs, mark the GM as a character, invent location/time, or pretend every known NPC is present to satisfy HUD filters.

Implement a narrow rule for the chat's initialized player record: expose it in the player sheet/HUD and continuity snapshot even when scene membership is not yet established. Keep existing scene filtering for NPCs. Respect feature visibility switches, and show their status clearly.

Check exact-name, owner normalization, User Only modes, and strict-present filtering. Avoid using substring matching as Persona identity.

### 7.4 Background analysis remains incremental

The analyzer should see the baseline through its ordinary current-state snapshot. It does not need the whole Persona template reinserted as an instruction to initialize on every turn.

Its first reply analysis must treat seeded items/skills as already present. A story merely mentioning an existing sword must not add another sword. Spending, losing, transferring, upgrading, and removing entries must update the current campaign state.

Retain existing stale-result rejection by chat/message/swipe/text identity and the protections around manual edits. Background reanalysis of the first reply or greeting must not wipe or replace the chat baseline.

This task guarantees initialization. It does not create a numerical combat rules engine. If prose only says “slightly tired” and establishes no numerical SP change, the current strict analyzer may leave SP unchanged; do not fix that by arbitrarily inventing damage/cost rules as part of this work.

### 7.5 Legacy mode

Bootstrap should coexist with Legacy mode without causing the normal tag parser to erase the seed. Keep Legacy's ordinary story-delta processing intact. Metadata mode must never regain a requirement for the main model to output Horae tags.

## 8. Existing chats, branches, and carryover

### 8.1 Existing chats

Do not automatically initialize old chats when the extension updates, when the option is enabled, or when a Persona is selected.

Provide an explicit “Apply missing starting entries to this chat” action with a reviewable preview. Default behavior:

- Preserve existing HP/MP/SP values and known current possessions.
- Show conflicts and known deleted/consumed entries as excluded.
- Require the user to select which genuinely missing entries to add; absence alone cannot prove an item was never consumed.
- Apply the approved repair at the current story boundary, not retroactively before the old transcript.
- Preserve a recoverable before-state or an existing undo mechanism.

Do not make destructive reset or template overwrite the default repair. If a full reset is offered later, label its scope explicitly and keep it separate.

### 8.2 Branches and exported/imported chats

A branch inherits the baseline and state history up to the branch point. It must not be mistaken for a fresh campaign and receive the template a second time. Renaming a chat must not reset its marker.

Native chat export/import must preserve committed baseline and provenance. Importing an already initialized chat remains initialized. An imported old transcript without a marker must not be auto-seeded on the assumption that no marker means no history.

### 8.3 Horae carryover

Audit `createNewChatWithCarryover()` and `_importAsInitialState()` specifically. They currently use their own state import/anchor logic.

For a carried campaign, preserve the effective state at the carry boundary and mark the target as inherited. Do not apply a fresh Persona starting template over it. If recent messages are also copied, ensure that the carried baseline and copied deltas represent disjoint portions of the history; do not replay the same state changes twice.

Do not blindly re-use `_importAsInitialState()` as the new initializer: its aggregate RPG writes and the message-zero HUD discrepancy need explicit treatment.

### 8.4 Explicit clear/reset

Ordinary deletion/regeneration of replies must preserve the chat baseline. A user explicitly choosing “clear all Horae state” is different: clear the baseline consistently and record an opt-out/disabled-for-this-chat status if needed so the next ordinary send does not immediately recreate what was just cleared. Provide a deliberate reinitialize action.

## 9. Prompt cleanup to deliver with the implementation

Do not rewrite the owner's Toaru world rules, NPC autonomy rules, player agency constraints, or narrative length limits. Make only targeted initialization/synchronization changes and provide copyable snippets.

For Metadata mode, after deterministic bootstrap is available:

1. Remove the opening's instruction that the GM must copy all Persona skills/items/strongholds into RPG state.
2. Remove the main prompt's “第一回合指令” that repeats this requirement.
3. Remove the “RPG状态更新” block requiring `[获得物品…]`, `[习得技能…]`, and other custom dump lines.
4. Replace the operational Horae-format instructions with narrative consistency rules. Retain story-time semantics and the owner's normal-item-system preference.

Suggested replacement greeting, in the owner's language:

```text
当前世界设定、玩家人设与可用资料已载入。

用户可以直接行动，也可以给出简短开局要求，例如“开始”“随机开局”“从日常场景开始”“从某个地点开始”或“从某个事件发生前开始”。

若用户未指定具体场景，则根据当前世界书、玩家身份与已有设定，确定合理的时间、地点、具体登场人物与事件，并生成第一幕。需要重要角色登场时，应确定符合当前设定的具体人物，不得长期以身份类别或泛称代替实际角色。
```

Suggested main-prompt replacement block:

```text
# 状态一致性

- 当前对话的初始属性、技能、物品与据点由外部功能配置；若已提供当前状态快照，直接据此叙事，不负责重新登记或初始化。
- Persona中的背景、能力原理及限制继续有效；对于生命、资源余量、物品数量与归属、已习得或已失去的技能等可变状态，以当前状态快照和其后明确发生的剧情为准。用户当前明确要求修改设定时，遵循用户要求。
- 不得因为Persona仍保留开局描述，便补回已经消耗或失去的物品、重置数值或恢复已经失去的技能。
- 回复只写剧情正文，不输出用于登记状态的标签、字段行或“获得物品／习得技能”等列表；剧情中的实际变化自然地体现于叙述。
- 没有提供数值或明确变化时，不得为了补全状态而编造属性值，也不得声称已完成实际上没有发生的初始化。
- 剧情时间只按故事实际流逝推进，与现实日期、系统时间及消息时间无关。
- 武器、衣物、饰品和其他装备仍作为可持有物处理；未经用户指令，不得擅自让玩家使用技能或装备。
```

These snippets are a handoff template, not a change already applied to the user's card. Do not present them as a complete fix before the code feature exists. Legacy users still need its native tag-generation rules for subsequent changes.

## 10. Acceptance criteria and focused tests

Implement meaningful unit tests for folding/eligibility and a small host-level test set for lifecycle, actual outgoing prompt contents, and HUD visibility. Existing `tests/stateSemantics.test.mjs`, `tests/bgAnalysis.test.mjs`, and `tests/e2e/` are useful starting points. Reuse their conventions rather than adding a parallel test framework.

### 10.1 Reference fixture

Use a non-sensitive fictional Persona named `测试玩家`, with:

- HP `100/100`, MP `60/60`, SP `80/80`.
- Two skills, each with a multi-sentence description and explicit limitation; one has no level label.
- Three possessions: a key, a coat, and two units of a consumable. Include multiline text and `|`, `=`, and `@` characters in at least one description.
- One stronghold and one nested room, with descriptions.

Assertions must compare names, descriptions, counts, values, and ownership, not merely whether arrays are nonempty.

### 10.2 Required behavioral checks

| Case | Expected result |
|---|---|
| Fresh chat, enabled valid profile | Complete baseline before the first main-model request; all configured descriptions preserved. |
| First reply never mentions possessions or stats | Initial HP, skills, inventory, and strongholds still exist and display correctly. |
| API disconnected before story generation | Bootstrap itself makes zero LLM requests and can still validate/persist locally. |
| Disabled/unconfigured profile | Existing Horae behavior; no automatic seed. |
| Invalid number or missing prerequisite | Visible, retryable result; no partial commit or false success marker. |
| Duplicate generation callbacks | One baseline and one effective copy of each item/skill. |
| Dry run, auxiliary request, impersonation | No initialization side effects. |
| Empty/multiple/variant greetings | Fresh-chat detection does not depend on one fixed message count. |
| Generation fails after successful bootstrap | Retry reuses the same baseline. |
| First generated message is index 0 | Direct snapshot and batch HUD agree; no seed omission. |
| Request snapshot before message 0 | Baseline included, that message's future delta excluded. |
| Player absent from initial cast metadata | Player sheet remains available; no invented scene/NPCs. |
| HP changes to 88, MP to 45 | Reload/rebuild leaves 88 and 45, not starting values. |
| Current HP is 0 | Preserved as 0; never mistaken for missing or refilled. |
| Consumable quantity falls from 2 to 1 to 0 | Correct remaining quantity/deletion, including after reload. |
| Key transferred to an NPC | Ownership remains transferred; no duplicate starting key. |
| Skill upgraded, then removed | Current version/deletion wins over the baseline through rebuild. |
| Unchanged turn mentions an existing item | No acquisition event or duplicate registration. |
| Swipe/regenerate first reply | Baseline retained; only the replaced reply's delta changes. |
| Reanalyze greeting/first reply | Baseline and initialization marker survive. |
| Delete all generated replies | Baseline retained; a new first scene does not seed again. |
| Reload and switch between chats | Each campaign retains its own baseline and current state. |
| Switch Persona during an initialized chat | No reset or new issuance; original owner retained, mismatch shown. |
| Same display name, different native Persona keys | Separate templates and no cross-chat state leakage. |
| Rename Persona/change image without changing key | Template binding preserved; no accidental reinitialization. |
| Edit reusable template after chat started | Existing campaign unchanged; new chat uses new revision. |
| Chat branch, rename, export/import | Initialization provenance retained; no second seed. |
| Carryover plus copied recent messages | Effective boundary state preserved with no double replay. |
| Old transcript with no marker | No automatic seed; manual preview required. |
| Manual repair of old chat | Selected missing entries added at current boundary; old HP/history untouched. |
| Explicit clear-all | Baseline cleared consistently; no surprise automatic restoration on next send. |
| Save failure or chat switch during preflight | No success marker without data; no write into another chat. |
| User Only / strict present / custom bar settings | Correct owner and consistent display/snapshot behavior. |
| Metadata mode | All existing `message.mes` strings byte-identical after state operations. |
| Legacy mode | Ordinary tag deltas still work; the baseline survives their replay. |
| Persona Library absent or disabled | Native Persona bootstrap still works. |

Use ordinary inventory for the coat and any weapon fixture. Assert that the feature does not populate the separate RPG equipment store.

Run the existing relevant tests to check that background deduplication, stale-response rejection, manual edits, and persistence semantics still work. Add host-level checks for the actual request order and rendered player sheet; core tests alone cannot prove browser lifecycle correctness. If a host/model is unavailable, report exactly which checks remain unrun rather than marking them passed.

## 11. Implementation workflow and deliverables

1. Inspect the installed host and current target branch; record versions and relevant local instructions. Confirm the actual `stateMode`, switches, and native Persona identity APIs when runtime access is available.
2. Briefly document the selected preflight hook and chat save path, including how internal requests and existing chats are excluded.
3. Add a small schema/validation and baseline-folding module, a native Persona adapter as needed, and a focused editor. Avoid placing all new business logic inside the already large `index.js`.
4. Connect the bootstrap to all relevant state readers and display paths. Fix the message-zero discrepancy as part of this work.
5. Add the targeted tests and run the available meaningful checks.
6. Document configuration, prompt cleanup, existing-chat repair, data migration/export, and known limitations.
7. Provide a concise final report listing changed files, actual tested behavior, any unrun host tests, and the copyable prompt replacements. Do not claim an initialization feature solves arbitrary numeric combat adjudication.

Prefer the simplest design meeting these requirements. A heavyweight plugin protocol, broad refactoring, extra Persona Library fork, or recurring AI extractor is unnecessary for v1.

## 12. Source map

Line anchors below refer to the audited commits. Function names are the primary navigation aids if the code has moved.

| Finding / area | Source |
|---|---|
| Background prompt construction, no Persona input | [Horae `index.js`, `_bgBuildPrompt`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/index.js#L20503) |
| Preceding USER action truncation | [Horae `index.js`, `_bgFindUserAction`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/index.js#L20489) |
| Analysis request preset isolation | [Horae `index.js`, `_getAuxApiPromptProfile`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/index.js#L17554) |
| Incremental-only and no-invented-stat rules | [Horae `core/bgAnalysis.js`, defaults](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/core/bgAnalysis.js#L495) |
| Fork's existing GM-prompt cleanup guide | [Horae `docs/METADATA_MODE.md`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/docs/METADATA_MODE.md#L32) |
| Persona Sections composition and saving | [Persona Library `modules/st-adapter.js`](https://github.com/Maxwell5600/Persona-Library/blob/b1cc092556fa2879b227c2706b2ccefb0cee9304/modules/st-adapter.js#L211) |
| Temporary Variant composition | [Persona Library `applyVariantPatch`](https://github.com/Maxwell5600/Persona-Library/blob/b1cc092556fa2879b227c2706b2ccefb0cee9304/modules/st-adapter.js#L476) |
| Native active Persona identity | [Persona Library imports](https://github.com/Maxwell5600/Persona-Library/blob/b1cc092556fa2879b227c2706b2ccefb0cee9304/modules/st-adapter.js#L7), [getActiveId](https://github.com/Maxwell5600/Persona-Library/blob/b1cc092556fa2879b227c2706b2ccefb0cee9304/modules/st-adapter.js#L695) |
| RPG line grammar | [Horae `core/horaeManager.js`, `_parseRpgLine`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/core/horaeManager.js#L1766) |
| Item state fold | [Horae `getLatestState`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/core/horaeManager.js#L195) |
| RPG aggregate rebuilding | [Horae `rebuildRpgData`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/core/horaeManager.js#L2285) |
| Historical RPG snapshots | [Horae `getRpgStateAt`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/core/horaeManager.js#L2416) |
| Batch HUD drops message-zero RPG changes | [Horae `_buildRpgSnapshotMap`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/index.js#L9802) |
| HUD present-character gating | [Horae `renderRpgHud`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/index.js#L9754) |
| Prompt state and present-character filtering | [Horae `generateCompactPrompt`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/core/horaeManager.js#L600) |
| Per-reply replacement and replay | [Horae `applyAnalysisResult`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/core/bgAnalysis.js#L220) |
| Public read/display API | [Horae `_publishHoraeApi`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/index.js#L1515) |
| Main-prompt lifecycle | [Horae `onPromptReady`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/index.js#L21691) |
| Carryover lifecycle | [Horae `createNewChatWithCarryover`](https://github.com/TaihouKai/SillyTavern-Horae-Metadata/blob/221e30415c0a3fb2162f699917c71829f36d959c/index.js#L19630) |

End of implementation brief.
