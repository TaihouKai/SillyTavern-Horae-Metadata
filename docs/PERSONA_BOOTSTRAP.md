# Persona starting state (deterministic initialization)

This feature gives each SillyTavern Persona an optional **starting profile** in Horae: resource bars with real numbers, skills, possessions and strongholds. When you start a new chat with that Persona, Horae writes the profile into the chat **once, before the first story request is built**. The GM does not need to recite an inventory or emit tags, and the background analyzer does not need to "discover" your starting kit from prose.

The feature is opt-in per Persona. Without an enabled profile, Horae behaves exactly as before.

---

## 1. Data model

Three kinds of data are kept apart:

| Kind | Where | Changes when |
|---|---|---|
| Reusable template | `extension_settings.horae.personaProfiles.profiles[<persona avatar key>]` | You edit and save it in the editor. Each save increments `revision`. |
| Chat baseline | `chat_metadata.horaePersonaBootstrap` (saved in the chat file header) | Once, at the start of a new chat. It is frozen afterwards. |
| Story deltas | Each message's `horae_meta` (unchanged Horae format) | Every turn, as before. |

State at any point = **baseline** + the valid story deltas up to that point, applied in order.

- The baseline and its "initialized" marker are **the same object**, so you can never end up with a marker that has no data.
- No fake message is created, and Metadata mode keeps every `message.mes` byte-identical.
- The template never receives live campaign values.
- The baseline is never re-applied on top of later changes.

The record contains:
- schema version and status (`applied`, `inherited`, `repaired` or `cleared`)
- the native Persona key and the captured player name (`owner`)
- template id and revision, and a commit id
- a frozen copy of the bars, skills, items and strongholds
- the chat's bar definitions (display name, color, description)
- an optional list of repairs

## 2. Configuring a profile

1. Open the Horae drawer and go to **RPG** (status card at the top) or **Settings → Persona starting state**. Click **Edit starting profile**.
2. The editor shows the Persona's avatar and name, with ★ marking the active Persona. You can pick any Persona from the list. Personas are resolved from SillyTavern's own data (`power_user.personas` and `user_avatar`), so Persona Library is not required. Personas that Persona Library manages work the same way, because they are native Personas.
3. Fill in the sections:
   - **Resource bars.** Each bar needs a machine key (`hp`, `mp`, `sp`, `mana`…), a display name (生命 / 魔力 / 体力…), the current value and the max value, plus an optional color and description. Values must be whole numbers ≥ 0, max must be > 0, and current must not exceed max. `0` is a valid current value. Invalid values are reported, never clamped. The **HP/MP/SP 100/100 preset** button adds visible rows that you can edit.
   - **Skills.** Name, an optional level, and a full description. Text is stored verbatim, including line breaks, `|`, `=` and `@`. It is never converted to `skill:…|…` and re-parsed.
   - **Possessions** use Horae's normal item system; nothing goes into the separate RPG equipment store. Fields:
     - name and full description
     - quantity (default 1) and optional unit, encoded as `急救喷雾(2瓶)` using Horae's existing base-name rules
     - holder (empty = this player)
     - optional location, icon and importance

     Names that the item system could not tell apart are rejected.
   - **Strongholds.** Name, optional level, description and an optional parent. Parent references and cycles are validated.
4. If any required Horae switch is off, the editor lists it. **Enable required switches** turns on only the ones this profile needs: context injection, RPG mode, and the bars / skills / stronghold / item modules.
5. Tick **Use this profile to initialize new chats**, then click **Save**. **Validate / preview** shows a structured preview or the exact errors.
6. **Export JSON** and **Import JSON** move a template between Personas or installs. Exports contain only template data: no Persona key, no campaign values and no API credentials.

Editing a template only affects **future** new chats. Chats that are already initialized keep their frozen baseline.

## 3. Lifecycle (SillyTavern 1.19.0, verified)

- **Hook.** Automatic initialization runs in `GENERATION_AFTER_COMMANDS`. SillyTavern awaits it inside `Generate()` and passes the generation type and dry-run flag. It fires before the prompt is assembled, and therefore before Horae builds its state snapshot in `CHAT_COMPLETION_PROMPT_READY`.
- **Excluded requests:**
  - Horae's own background analysis, summaries and query rewrite use `generateRaw`, which never emits this event.
  - `quiet` and `impersonate` generations and dry runs are excluded explicitly.
- **Eligibility.** All of the following must hold:
  - Horae is enabled.
  - The active Persona has an enabled, valid profile.
  - All prerequisites are on.
  - The chat has **no** bootstrap record of any status.
  - No AI message appears after the first user message.

  Greetings (any number, empty, with alternate swipes) and pressing "Start" do not count as story. An old transcript that already has replies is never seeded automatically.
- **Commit.**
  - The whole profile is validated before anything is written.
  - The chat key, metadata object and Persona key are checked again immediately before writing.
  - The record is written and saved with `saveMetadata()` (the same chat-file save SillyTavern uses).
  - The RPG aggregate cache on `chat[0]` is then rebuilt from baseline plus deltas.
  - Concurrent triggers for the same chat share one in-flight commit.
- **Failure.**
  - The status card shows the reason (invalid profile, prerequisites off, player name not resolved, chat changed, or save failed), and a toast appears.
  - The generation is cancelled with SillyTavern's `stopGeneration()`, so the first story is never sent with half the promised state.
  - Sending again retries.
- **After success.** If the story request itself fails or is regenerated, the retry reuses the same baseline; nothing is issued twice.
- **No LLM calls.** Initialization makes no model requests and works with the API disconnected, right up to the point where the story request goes out.

## 4. State integration

The baseline is applied, in a single shared fold, before message 0 in every reader:

- `getLatestState()` (items) and `getRpgStateAt()` (bars, status, skills, strongholds)
- `rebuildRpgData()` (the aggregate) and the bulk HUD snapshot `_buildRpgSnapshotMap()`
- the main and analyzer snapshots from `generateCompactPrompt()`
- the drawer and HUD

Later deltas override it in order. Spending, transferring, upgrading, removing and deleting all take precedence and survive reload and rebuild.

Fixes included:
- `_buildRpgSnapshotMap()` no longer skips message 0's RPG changes, so the bulk HUD and direct snapshots now agree.
- `getRpgStateAt()` used `Math.max(1, …)`, so the state *before* message 0 included message 0's own changes. It now contains only the baseline.

Player visibility: the initialized player (`owner`) is shown in the HUD, the RPG drawer and the main-model snapshot even before any scene has established a cast list. NPCs are still filtered by presence as before. No NPC, time or location is invented. Strict-present and User Only modes keep the player visible.

Bar definitions: the chat's snapshotted bar definitions take precedence over the global `rpgBarConfig`. Global bars that aren't in the snapshot remain available. Switching Personas never rewrites the global bar configuration.

The background analyzer receives the baseline through its ordinary state snapshot. Starting items and skills are therefore "already present": mentioning the key again adds nothing, while using the last spray deletes it.

## 5. Existing chats, branches, carryover, clearing

- **Old chats are never initialized automatically.** In a chat that already has story, use **Apply missing entries…**:
  - The preview lists every template entry as `missing`, `already present — kept`, `present with a different holder — kept`, or `previously removed/consumed — excluded`.
  - Only genuinely missing entries can be selected, and nothing is selected by default.
  - The selected entries are applied **at the current point of the story**, not retroactively.
  - Existing HP and possessions are preserved.
  - **Undo last repair** removes the most recent repair.
- **Branches.** SillyTavern copies `chat_metadata` into the branch, so a branch keeps the same baseline and its history up to the branch point. It is never seeded again. Renaming a chat or exporting/importing a chat file keeps the record, because it lives in the chat file header. An imported old transcript without a record is not seeded.
- **Horae carryover** ("new chat with carryover"):
  - The new chat receives an **inherited** baseline: the source chat's effective items, bars, status, skills and strongholds just before the first copied message, including the source's own baseline.
  - The copied messages' deltas are then replayed on top of it, so the two ranges never overlap.
  - The Persona template is not applied again.
  - Previously, carryover wrote these values only into the `chat[0]` aggregate, where a rebuild could lose them, and then replayed the copied messages again.
- **Clear all Horae data** also clears the baseline and records a `cleared` opt-out, so the next ordinary send does not silently restore it. **Initialize this chat now** is the deliberate way to re-initialize.

## 6. Persona identity

- Templates are keyed by the native Persona avatar key, as returned by `user_avatar` from `/scripts/personas.js`.
- Two Personas with the same display name keep separate templates.
- Renaming a Persona or replacing its image keeps the key, so the binding survives.
- Duplicating a Persona creates a new key without a template. Use Export/Import to copy one.
- Deleting a Persona does not touch any chat's frozen baseline.

At initialization the record captures both the Persona key and the resolved player name (`name1`).

If you switch to a different Persona inside an initialized chat:
- Horae does not re-initialize the chat.
- Nothing is transferred to the new Persona.
- The original owner is kept, and the status card shows a mismatch warning.

Automatic migration of history to a renamed or different player is not part of v1.

## 7. Prompt cleanup (copy into your GM card yourself)

These snippets are a template. They were **not** applied to any card. Keep your world rules, NPC autonomy rules, player-agency constraints and length limits.

For Metadata mode, now that deterministic initialization exists:

1. Remove the opening's instruction that the GM must copy all Persona skills, items and strongholds into the RPG state.
2. Remove the main prompt's "第一回合指令" that repeats this.
3. Remove the "RPG状态更新" block that asks for `[获得物品…]`, `[习得技能…]` and similar dump lines.
4. Replace the operational Horae-format instructions with the narrative-consistency block below.

Suggested greeting:

```text
当前世界设定、玩家人设与可用资料已载入。

用户可以直接行动，也可以给出简短开局要求，例如“开始”“随机开局”“从日常场景开始”“从某个地点开始”或“从某个事件发生前开始”。

若用户未指定具体场景，则根据当前世界书、玩家身份与已有设定，确定合理的时间、地点、具体登场人物与事件，并生成第一幕。需要重要角色登场时，应确定符合当前设定的具体人物，不得长期以身份类别或泛称代替实际角色。
```

Suggested main-prompt block:

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

Legacy-mode users still need Horae's own tag-generation rules for later changes; only the initialization part is replaced.

This feature guarantees initialization. It is **not** a combat-rules engine: if the prose only says "slightly tired" and states no number, the strict analyzer may leave SP unchanged.

## 8. Test report

Fixture: Persona `测试玩家`, configured as follows:

| Part | Contents |
|---|---|
| Bars | HP 100/100, MP 60/60, SP 80/80 |
| Skills | Two, each with a multi-sentence description and an explicit limitation; one has no level |
| Items | A key (description with `|`, `=`, `@` and a line break), a coat, and two units of a consumable |
| Strongholds | A safe house and a nested workshop |

Assertions compare names, descriptions, counts, values and ownership.

### Unit tests: `tests/personaBootstrap.test.mjs` → 26 / 26 pass

The unit tests use the real `horaeManager`, the analysis-commit path shared with `index.js`, and the controller with a stub host. They cover:

- **Validation:** zero, non-numbers, over-max, max = 0, duplicate/reserved/unsafe keys, duplicate skills and items, quantity suffixes, cycles and missing parents. Errors are reported and values are never clamped.
- **First turn:** the full baseline appears in every reader even when the first reply mentions nothing, and no equipment entries are created.
- **Later deltas through rebuilds:** HP 88 / MP 45 and HP 0 persist; the consumable goes 2 → 1 → 0 → deleted; key transfer keeps the new holder with no duplicate; a skill upgrade and then removal both win.
- **Message 0 as the first generated message:** the snapshot taken before it has only the baseline.
- **Re-analysis, deletion, swipe:** re-analyzing the greeting or first reply, deleting all replies, and swiping the first reply all keep the baseline.
- **Snapshot visibility:** the player appears without a cast list; NPC filtering is unchanged; chat bar names override global ones; User Only and strict-present modes behave correctly.
- **Legacy mode:** inline tags still apply and the baseline survives.
- **Other record states:** a cleared record is inert; repairs land at the current boundary, preserve old HP and exclude consumed items; carryover reproduces the source state without double replay.
- **Controller lifecycle:**
  - one commit for duplicate triggers, and reuse on retry
  - nothing happens for a disabled profile, a dry run, `quiet` or `impersonate`
  - an invalid profile or missing prerequisite stops generation without writing
  - a save failure leaves no marker
  - a chat switch during save never writes into the new chat
  - an old transcript is not seeded
  - personas with the same name but different keys stay separate
  - template edits don't affect existing chats
  - a Persona switch shows a mismatch and doesn't reseed
  - clear-all opts out, and manual re-initialize works
- **Data hygiene:** export/import round-trips, and `mes` is unchanged.

The existing 37 unit tests (background analysis and state semantics) still pass: **63 / 63 in total**.

### Browser end-to-end in SillyTavern 1.19.0: `tests/e2e/persona.mjs` → 27 / 27 pass

- **Editor:** "enable required switches", JSON import, save with a structured preview.
- **New chat:** status "ready" before sending; the record is committed **before** the first main-model request; bootstrap makes no LLM request; the first request contains bars, skills, items and strongholds and no tag instructions; the HUD shows the player sheet without a cast; the equipment store stays empty.
- **Reload:** same record, HP 88 / MP 45 kept, HUD current, all `mes` byte-identical.
- **Branch:** same record, current state carried, no second seed.
- **Regenerate:** same record, one copy of each item.
- **Clear-all:** not restored on the next send.
- **Missing prerequisite:** no request sent and no reply; after enabling the switch, the retry initializes.
- **Old transcripts and repair:** a disabled profile is not seeded; an old transcript shows "not eligible" and is not seeded; the repair preview adds the selected entries at the current boundary.
- **Carryover:** the target is marked inherited, with HP 88, one spray left and one key.
- **Errors:** no page errors from the feature.

The full regression suite also passes after the change:

| Suite | Result |
|---|---|
| `tests/e2e/run.mjs` | 57 / 57 |
| `tests/e2e/mainApiOnly.mjs` | 5 / 5 |
| `tests/e2e/stateDump.mjs` | 7 / 7 |
| `tests/e2e/migration.mjs` | 5 / 5 |

`persona.mjs` disables its profile at the end so it doesn't affect the other scripts that share the test instance.

### Not run

- **No real LLM:** the GM and analyzer replies were scripted by the mock server.
- **Not tested at host level:**
  - with Persona Library installed (it wasn't present in the test instance)
  - group-chat initialization
  - renaming a Persona or changing its image in the browser (the key-based binding is covered by unit tests)
  - chat file export and re-import through the UI
  - mobile browsers
- **Owner's install unseen:** I had no access to your running SillyTavern, its `stateMode`, or its Persona data.

## 9. Known limitations

- **Cancellation side effects.** When a prerequisite fails, the generation is cancelled with `stopGeneration()`. The user message stays in the chat (send or regenerate again to retry), and SillyTavern logs its usual "Generation was aborted" error.
- **Silent save failures.** `saveChatConditional()` swallows HTTP save errors. Horae catches thrown errors only. If a save fails silently, the record stays in memory and is written by the next chat save. A "marker without data" state is still impossible, because they are one object.
- **Renamed player.** The captured owner name doesn't follow a later Persona rename. With *User Only* bars enabled, the HUD then hides the old owner, and the status card shows the mismatch.
- **Repair boundary.** A repair is anchored to a message index. Deleting messages before that index moves the boundary earlier, never past the end of the chat.
- **Carryover behaviour change.** Carryover now always creates an inherited baseline for items, bars, status, skills and strongholds, even without a Persona profile. Equipment, currency, reputation and levels still use the previous seed path.
- **No prose import.** There is no assistant for importing a profile from Persona prose (optional in the brief). Use manual entry or JSON import.
- **Localization.** Traditional Chinese uses the Simplified Chinese strings through the existing fallback.
