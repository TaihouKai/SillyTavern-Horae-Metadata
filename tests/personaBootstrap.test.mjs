/**
 * Persona 开局状态：校验、基线折叠、资格判定、补录、继承与生命周期（控制器，使用桩上下文）
 * 运行：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horaeManager, createEmptyMeta, msg, setup, parse, commit, rebuildAll } from './helpers.mjs';

const pb = await import('../core/personaBootstrap.js');
const { createPersonaController } = await import('../core/personaController.js');

const P = '测试玩家';
const KEY_DESC = '刻着 A|B=C@3F 的黄铜钥匙。\n第二行：备用钥匙在公寓管理员处。';
const SKILL1_DESC = '能感知半径五米内的电磁场变化，并据此判断电子设备的位置。\n限制：雨天精度下降一半；无法感知绝缘体后方的物体。';
const SKILL2_DESC = '在危机中强制保持冷静并梳理线索。限制：每天只能主动使用一次，使用后会剧烈头痛。';

/** 参考模板（10.1） */
function fixtureProfile() {
    return {
        enabled: true,
        bars: [
            { key: 'hp', name: '生命', current: 100, max: 100, color: '#ef4444', desc: '' },
            { key: 'mp', name: '魔力', current: 60, max: 60, color: '#3b82f6', desc: '' },
            { key: 'sp', name: '体力', current: 80, max: 80, color: '#22c55e', desc: '' },
        ],
        skills: [
            { name: '电磁感知', level: 'Lv3', desc: SKILL1_DESC },
            { name: '冷静分析', level: '', desc: SKILL2_DESC },
        ],
        items: [
            { name: '旧公寓钥匙', icon: '🔑', quantity: 1, description: KEY_DESC },
            { name: '灰色风衣', icon: '🧥', quantity: 1, description: '防水风衣，内袋可放证件。', location: '身上' },
            { name: '急救喷雾', icon: '🧴', quantity: 2, unit: '瓶', description: '一次性止血喷雾。限制：每瓶只能用一次。', importance: '!' },
        ],
        strongholds: [
            { id: 'base1', name: '第七学区安全屋', level: 1, desc: '老旧公寓顶层，门锁已更换。' },
            { id: 'room1', name: '地下工作室', parent: 'base1', desc: '安全屋地下的改装工作间。\n有独立电源。' },
        ],
    };
}

/** 建立带开局基线的聊天：chat_metadata 记录 + provider */
function seeded(chat, settings = {}) {
    const ctx = setup(chat, settings);
    ctx.name1 = P;
    const v = pb.validateProfile(fixtureProfile());
    assert.ok(v.ok, JSON.stringify(v.errors));
    const meta = { [pb.PB_META_KEY]: pb.createBootstrapRecord({ normalized: v.normalized, personaKey: 'p_a.png', owner: P, chatKey: 'c1' }) };
    horaeManager.setBootstrapProvider(() => meta[pb.PB_META_KEY]);
    return { ctx, meta, record: meta[pb.PB_META_KEY] };
}

const items = () => horaeManager.getLatestState().items;
const rpgNow = () => horaeManager.getRpgStateAt(0);
const bars = () => rpgNow().bars?.[P];

function assertFullBaseline() {
    const it = items();
    assert.deepEqual(Object.keys(it).sort(), ['急救喷雾(2瓶)', '旧公寓钥匙', '灰色风衣'].sort());
    assert.equal(it['旧公寓钥匙'].description, KEY_DESC);
    assert.equal(it['旧公寓钥匙'].holder, P);
    assert.equal(it['旧公寓钥匙'].location, '');
    assert.equal(it['灰色风衣'].location, '身上');
    assert.equal(it['急救喷雾(2瓶)'].importance, '!');
    const r = rpgNow();
    assert.deepEqual(r.bars[P].hp.slice(0, 2), [100, 100]);
    assert.deepEqual(r.bars[P].mp.slice(0, 2), [60, 60]);
    assert.deepEqual(r.bars[P].sp.slice(0, 2), [80, 80]);
    assert.deepEqual(r.skills[P].map(s => [s.name, s.level, s.desc]), [['电磁感知', 'Lv3', SKILL1_DESC], ['冷静分析', '', SKILL2_DESC]]);
    const sh = r.strongholds;
    const base = sh.find(n => n.name === '第七学区安全屋');
    const room = sh.find(n => n.name === '地下工作室');
    assert.ok(base && room, JSON.stringify(sh));
    assert.equal(room.parent, base.id);
    assert.equal(room.desc, '安全屋地下的改装工作间。\n有独立电源。');
    assert.deepEqual(r.equipment, {}, 'separate RPG equipment store must stay empty');
}

// ---------------- 校验 ----------------

test('validate: reference fixture is valid and preserves text verbatim', () => {
    const v = pb.validateProfile(fixtureProfile());
    assert.ok(v.ok, JSON.stringify(v.errors));
    assert.equal(v.normalized.skills[0].desc, SKILL1_DESC);
    assert.equal(v.normalized.items[0].description, KEY_DESC);
    assert.equal(v.normalized.items[2].quantity, 2);
});

test('validate: invalid values are rejected, never clamped; 0 is a valid current value', () => {
    const bad = (patch) => pb.validateProfile({ ...fixtureProfile(), ...patch });
    const codes = (r) => r.errors.map(e => e.code);
    assert.ok(codes(bad({ bars: [{ key: 'hp', current: 120, max: 100 }] })).includes('barCurrentOverMax'));
    assert.ok(codes(bad({ bars: [{ key: 'hp', current: 1, max: 0 }] })).includes('barMaxZero'));
    assert.ok(codes(bad({ bars: [{ key: 'hp', current: 'healthy', max: 100 }] })).includes('barCurrentInvalid'));
    assert.ok(codes(bad({ bars: [{ key: 'hp', current: -1, max: 100 }] })).includes('barCurrentInvalid'));
    assert.ok(codes(bad({ bars: [{ key: 'hp', current: 1.5, max: 100 }] })).includes('barCurrentInvalid'));
    assert.ok(codes(bad({ bars: [{ key: 'hp', current: 1, max: 10 }, { key: 'HP', current: 1, max: 10 }] })).includes('barKeyDuplicate'));
    assert.ok(codes(bad({ bars: [{ key: 'status', current: 1, max: 10 }] })).includes('barKeyReserved'));
    assert.ok(codes(bad({ bars: [{ key: '__proto__', current: 1, max: 10 }] })).includes('barKeyUnsafe'));
    assert.ok(codes(bad({ bars: [{ key: '生命', current: 1, max: 10 }] })).includes('barKeyInvalid'));
    assert.ok(codes(bad({ skills: [{ name: 'A', desc: '' }, { name: 'A', desc: 'x' }] })).includes('skillDuplicate'));
    assert.ok(codes(bad({ items: [{ name: '急救喷雾(2)' }] })).includes('itemNameHasQuantity'));
    assert.ok(codes(bad({ items: [{ name: '钥匙' }, { name: '钥匙', quantity: 3 }] })).includes('itemDuplicate'));
    assert.ok(codes(bad({ items: [{ name: '钥匙', quantity: 0 }] })).includes('itemQuantityInvalid'));
    assert.ok(codes(bad({ strongholds: [{ id: 'a', name: 'A', parent: 'b' }, { id: 'b', name: 'B', parent: 'a' }] })).includes('shCycle'));
    assert.ok(codes(bad({ strongholds: [{ id: 'a', name: 'A', parent: 'zzz' }] })).includes('shParentMissing'));
    const zero = bad({ bars: [{ key: 'hp', current: 0, max: 100 }] });
    assert.ok(zero.ok);
    assert.equal(zero.normalized.bars[0].current, 0);
    const lower = bad({ bars: [{ key: 'Mana', current: 5, max: 10 }] });
    assert.ok(lower.ok && lower.normalized.bars[0].key === 'mana' && lower.warnings.length === 1, 'key normalization is reported');
});

// ---------------- 基线折叠 ----------------

test('fresh chat: complete baseline visible to every reader; first reply never mentions anything', () => {
    const chat = [msg('开场白。'), msg('开始', { user: true }), msg('雨夜，你站在公寓门口。')];
    seeded(chat);
    commit(chat, 2, parse('<horaenochange/>'));
    assertFullBaseline();
    rebuildAll();
    const agg = horaeManager.getRpgData();
    assert.deepEqual(agg.bars[P].hp.slice(0, 2), [100, 100]);
    assert.equal(agg.skills[P].length, 2);
    assert.ok(agg.strongholds.some(n => n.name === '地下工作室'));
    assert.deepEqual(agg.equipment, {});
    for (const m of chat) assert.ok(!/<horae/.test(m.mes));
});

test('HP 88 / MP 45 survive rebuild; HP 0 is preserved, never refilled', () => {
    const chat = [msg('开场白。'), msg('冲上去', { user: true }), msg('你被击中。')];
    seeded(chat);
    commit(chat, 2, parse(`<horaerpg>\nhp:${P}=88/100\nmp:${P}=45/60\n</horaerpg>`));
    rebuildAll();
    assert.deepEqual(bars().hp.slice(0, 2), [88, 100]);
    assert.deepEqual(bars().mp.slice(0, 2), [45, 60]);
    assert.deepEqual(bars().sp.slice(0, 2), [80, 80]);
    assert.deepEqual(horaeManager.getRpgData().bars[P].hp.slice(0, 2), [88, 100]);
    chat.push(msg('继续', { user: true }), msg('你倒下了。'));
    commit(chat, 4, parse(`<horaerpg>\nhp:${P}=0/100\n</horaerpg>`));
    rebuildAll();
    assert.deepEqual(bars().hp.slice(0, 2), [0, 100]);
    assert.deepEqual(horaeManager.getRpgData().bars[P].hp.slice(0, 2), [0, 100]);
});

test('consumable 2 → 1 → 0 then deleted; stays deleted after rebuild', () => {
    const chat = [msg('开场白。'), msg('用喷雾', { user: true }), msg('你用掉一瓶喷雾。')];
    seeded(chat);
    commit(chat, 2, parse(`<horae>\nitem:🧴急救喷雾(1瓶)|一次性止血喷雾。=${P}\n</horae>`));
    assert.ok(items()['急救喷雾(1瓶)']);
    assert.ok(!items()['急救喷雾(2瓶)']);
    assert.equal(Object.keys(items()).filter(n => n.startsWith('急救喷雾')).length, 1);
    chat.push(msg('再用', { user: true }), msg('最后一瓶也用完了。'));
    commit(chat, 4, parse(`<horae>\nitem:🧴急救喷雾(0瓶)=${P}\n</horae>`));
    rebuildAll();
    assert.equal(Object.keys(items()).filter(n => n.startsWith('急救喷雾')).length, 0);
});

test('key transferred to an NPC keeps its owner; no duplicate starting key; unchanged mention adds nothing', () => {
    const chat = [msg('开场白。'), msg('把钥匙给她', { user: true }), msg('你把钥匙交给了白井。')];
    seeded(chat);
    commit(chat, 2, parse(`<horae>\nitem:🔑旧公寓钥匙=白井黑子@手中\n</horae>`));
    chat.push(msg('看看口袋', { user: true }), msg('口袋里只有风衣的内袋和那串钥匙的回忆。'));
    commit(chat, 4, parse('<horaenochange/>'));
    rebuildAll();
    const keys = Object.entries(items()).filter(([n]) => n.startsWith('旧公寓钥匙'));
    assert.equal(keys.length, 1);
    assert.equal(keys[0][1].holder, '白井黑子');
    assert.equal(keys[0][1].description, KEY_DESC, 'description from the baseline survives a holder change');
});

test('skill upgraded then removed: current version wins through rebuild', () => {
    const chat = [msg('开场白。'), msg('训练', { user: true }), msg('你的感知更敏锐了。')];
    seeded(chat);
    commit(chat, 2, parse(`<horaerpg>\nskill:${P}|电磁感知|Lv4|半径扩大到八米\n</horaerpg>`));
    rebuildAll();
    assert.equal(rpgNow().skills[P].find(s => s.name === '电磁感知').level, 'Lv4');
    chat.push(msg('…', { user: true }), msg('能力被封印。'));
    commit(chat, 4, parse(`<horaerpg>\nskill-:${P}|电磁感知\n</horaerpg>`));
    rebuildAll();
    assert.ok(!rpgNow().skills[P].some(s => s.name === '电磁感知'));
    assert.ok(!horaeManager.getRpgData().skills[P].some(s => s.name === '电磁感知'));
    assert.ok(rpgNow().skills[P].some(s => s.name === '冷静分析'));
});

test('first generated message is index 0: snapshot before it has the baseline only', () => {
    const chat = [msg('（没有开场白，GM 的第一幕）你醒来时 HP 只剩九十。')];
    seeded(chat);
    commit(chat, 0, parse(`<horaerpg>\nhp:${P}=90/100\n</horaerpg>`));
    assert.deepEqual(horaeManager.getRpgStateAt(0).bars[P].hp.slice(0, 2), [90, 100]);
    assert.deepEqual(horaeManager.getRpgStateAt(1).bars[P].hp.slice(0, 2), [100, 100], 'state before message 0 excludes its delta');
    rebuildAll();
    assert.deepEqual(horaeManager.getRpgData().bars[P].hp.slice(0, 2), [90, 100]);
    assert.equal(horaeManager.getRpgData()._baselineMark.split(':')[0], horaeManager.getBootstrapRecord().commitId);
});

test('reanalysis of greeting / first reply and deletion of all replies keep the baseline', () => {
    const chat = [msg('开场白。'), msg('开始', { user: true }), msg('第一幕。')];
    const { meta } = seeded(chat);
    commit(chat, 0, parse('<horae>\nlocation:公寓门口\n</horae>'));
    commit(chat, 2, parse(`<horaerpg>\nhp:${P}=70/100\n</horaerpg>`));
    commit(chat, 2, parse('<horaenochange/>')); // 重新分析第一条回复
    commit(chat, 0, parse('<horaenochange/>')); // 重新分析开场白
    assert.ok(meta[pb.PB_META_KEY]);
    assertFullBaseline();
    chat.splice(1); // 删除全部生成的回复
    rebuildAll();
    assertFullBaseline();
    assert.equal(pb.assessFreshChat(chat, meta[pb.PB_META_KEY]).fresh, false, 'a new first scene does not seed again');
});

test('swipe on the first reply: only the replaced reply delta changes', () => {
    const chat = [msg('开场白。'), msg('开始', { user: true }), msg('版本A：你受了轻伤。', { swipes: ['版本A：你受了轻伤。', '版本B：你毫发无伤。'] })];
    seeded(chat);
    commit(chat, 2, parse(`<horaerpg>\nhp:${P}=90/100\n</horaerpg>`));
    chat[2].swipe_id = 1;
    chat[2].mes = chat[2].swipes[1];
    commit(chat, 2, parse('<horaenochange/>'));
    rebuildAll();
    assert.deepEqual(bars().hp.slice(0, 2), [100, 100]);
    assertFullBaseline();
});

test('player is in the main snapshot without a cast list; NPC filtering unchanged; chat bar names win', () => {
    const chat = [msg('开场白。'), msg('开始', { user: true }), msg('第一幕。')];
    seeded(chat, { sendRpgStronghold: true, rpgBarConfig: [{ key: 'hp', name: 'HP', color: '#000000' }, { key: 'stamina', name: '耐力' }] });
    let prompt = horaeManager.generateCompactPrompt(0);
    assert.match(prompt, /生命 100\/100/);
    assert.match(prompt, /魔力 60\/60/);
    assert.match(prompt, /电磁感知 Lv3/);
    assert.match(prompt, /旧公寓钥匙/);
    assert.match(prompt, /地下工作室/);
    // 场景名单只有 NPC：NPC 仍按在场过滤，玩家照常可见
    commit(chat, 2, parse(`<horae>\ncharacters:白井黑子\n</horae>\n<horaerpg>\nhp:路人甲=10/10\nhp:白井黑子=50/50\n</horaerpg>`));
    prompt = horaeManager.generateCompactPrompt(0);
    assert.match(prompt, /生命 100\/100/);
    assert.match(prompt, /白井黑子/);
    assert.doesNotMatch(prompt, /路人甲/);
    const eff = horaeManager.getEffectiveBarConfig();
    assert.equal(eff.find(b => b.key === 'hp').name, '生命');
    assert.ok(eff.some(b => b.key === 'stamina'), 'global-only bars stay available');
    assert.doesNotMatch(prompt, /<horae>|输出/);
});

test('User Only bars and strict-present mode keep the player visible', () => {
    const chat = [msg('开场白。'), msg('开始', { user: true }), msg('第一幕。')];
    seeded(chat, { rpgBarsUserOnly: true, rpgStrictPresentOnly: true });
    const prompt = horaeManager.generateCompactPrompt(0);
    assert.match(prompt, /生命 100\/100/);
});

test('legacy mode: inline tag deltas still apply and the baseline survives their replay', () => {
    const chat = [msg('开场白。'), msg('开始', { user: true }), msg('剧情\n<horaerpg>\nhp:测试玩家=77/100\n</horaerpg>\n<horae>\nitem:📄地图=测试玩家\n</horae>')];
    seeded(chat, { stateMode: 'legacy' });
    horaeManager.processAIResponse(2, chat[2].mes);
    rebuildAll();
    assert.deepEqual(bars().hp.slice(0, 2), [77, 100]);
    assert.ok(items()['地图']);
    assert.ok(items()['旧公寓钥匙']);
    assert.equal(rpgNow().skills[P].length, 2);
});

test('cleared record is inactive: no baseline, no owner', () => {
    const chat = [msg('开场白。')];
    const { meta } = seeded(chat);
    meta[pb.PB_META_KEY] = { v: 1, status: pb.PB_STATUS.CLEARED };
    assert.deepEqual(items(), {});
    assert.equal(horaeManager.getBootstrapOwner(), '');
    rebuildAll();
    assert.deepEqual(horaeManager.getRpgData().bars, {});
});

// ---------------- 资格 / 生成类型 ----------------

test('fresh-chat detection does not depend on a fixed message count', () => {
    const g = (t) => msg(t);
    const u = (t) => msg(t, { user: true });
    assert.equal(pb.assessFreshChat([], null).fresh, true);
    assert.equal(pb.assessFreshChat([g('')], null).fresh, true, 'empty greeting');
    assert.equal(pb.assessFreshChat([g('a'), g('b'), g('c')], null).fresh, true, 'group greetings');
    assert.equal(pb.assessFreshChat([{ ...g('a'), swipes: ['a', 'b'] }, u('开始')], null).fresh, true, 'greeting variants + Start');
    assert.equal(pb.assessFreshChat([u('开始')], null).fresh, true);
    assert.equal(pb.assessFreshChat([g('a'), u('x'), g('story')], null).fresh, false, 'old transcript');
    assert.equal(pb.assessFreshChat([g('a')], { status: 'cleared' }).fresh, false, 'explicit clear is an opt-out');
    for (const [type, dry, ok] of [['normal', false, true], [undefined, false, true], ['regenerate', false, true], ['swipe', false, true],
        ['quiet', false, false], ['impersonate', false, false], ['normal', true, false]]) {
        assert.equal(pb.isNarrativeGeneration(type, dry), ok, `${type}/${dry}`);
    }
});

// ---------------- 旧聊天补录 ----------------

test('repair: existing values kept, removed entries excluded, selected entries added at the current boundary', () => {
    const chat = [msg('开场白。'), msg('旧剧情1', { user: true }), msg('你受伤了。'), msg('旧剧情2', { user: true }), msg('你用掉了喷雾。')];
    const ctx = setup(chat);
    ctx.name1 = P;
    const meta = {};
    horaeManager.setBootstrapProvider(() => meta[pb.PB_META_KEY]);
    commit(chat, 2, parse(`<horaerpg>\nhp:${P}=50/100\n</horaerpg>\n<horae>\nitem:🧴急救喷雾=${P}\n</horae>`));
    commit(chat, 4, parse(`<horae>\nitem-:急救喷雾\n</horae>`));
    const before = chat.map(m => m.mes);
    const normalized = pb.validateProfile(fixtureProfile()).normalized;
    const removedItemBases = new Set(['急救喷雾']);
    const rows = pb.planRepair(normalized, P, { items: items(), rpg: rpgNow(), removedItemBases, removedSkills: new Set(), deletedStrongholds: [] });
    const st = Object.fromEntries(rows.map(r => [r.key, r.status]));
    assert.equal(st['bar:hp'], 'present');
    assert.equal(st['bar:mp'], 'missing');
    assert.equal(st['item:急救喷雾'], 'removed');
    assert.equal(st['item:旧公寓钥匙'], 'missing');
    const { entry, picked } = pb.buildRepairEntry(rows, ['bar:hp', 'bar:mp', 'item:旧公寓钥匙', 'item:急救喷雾', 'sh:room1'], P, chat.length - 1);
    assert.equal(picked, 3, 'present/removed rows cannot be picked');
    const orphan = pb.buildRepairEntry(rows, ['sh:room1'], P, chat.length - 1);
    assert.equal(orphan.error?.code, 'shParentNotSelected');
    meta[pb.PB_META_KEY] = { v: 1, status: pb.PB_STATUS.REPAIRED, owner: P, commitId: 'r1', baseline: null, barDefs: [], repairs: [entry] };
    rebuildAll();
    assert.deepEqual(bars().hp.slice(0, 2), [50, 100], 'old HP untouched');
    assert.deepEqual(bars().mp.slice(0, 2), [60, 60]);
    assert.ok(items()['旧公寓钥匙']);
    assert.ok(!items()['急救喷雾(2瓶)'], 'consumed item not restored');
    // 边界之前的历史状态不变（不追溯）
    assert.ok(!horaeManager.getLatestState(1).items['旧公寓钥匙']);
    assert.equal(horaeManager.getRpgStateAt(1).bars[P].mp, undefined);
    assert.deepEqual(chat.map(m => m.mes), before);
});

// ---------------- 继承（carryover） ----------------

test('carryover: boundary state + copied deltas reproduce the source state without double replay', () => {
    const src = [msg('开场白。'), msg('a', { user: true }), msg('你受伤。'), msg('b', { user: true }), msg('你用掉一瓶喷雾，又捡到地图。')];
    const { record } = seeded(src);
    commit(src, 2, parse(`<horaerpg>\nhp:${P}=80/100\n</horaerpg>`));
    commit(src, 4, parse(`<horae>\nitem:🧴急救喷雾(1瓶)=${P}\nitem:📄地图=${P}\n</horae>\n<horaerpg>\nhp:${P}=70/100\n</horaerpg>`));
    const srcItems = JSON.stringify(Object.keys(items()).sort());
    const srcBars = JSON.stringify(bars());
    const carryStart = 3; // 携带最后一轮（user b + AI）
    const skip = src.length - carryStart;
    const inherited = pb.createBootstrapRecord({ normalized: null, personaKey: record.personaKey, owner: P, chatKey: '', status: pb.PB_STATUS.INHERITED,
        baseline: pb.baselineFromState({ items: horaeManager.getLatestState(skip).items, rpg: horaeManager.getRpgStateAt(skip), owner: P }) });
    const carried = JSON.parse(JSON.stringify(src.slice(carryStart)));
    const target = [msg('（携带锚点）'), ...carried];
    setup(target).name1 = P;
    const meta2 = { [pb.PB_META_KEY]: inherited };
    horaeManager.setBootstrapProvider(() => meta2[pb.PB_META_KEY]);
    rebuildAll();
    assert.equal(JSON.stringify(Object.keys(items()).sort()), srcItems);
    assert.equal(JSON.stringify(bars()), srcBars);
    assert.equal(rpgNow().skills[P].length, 2);
    assert.ok(rpgNow().strongholds.some(n => n.name === '地下工作室'));
    assert.equal(pb.assessFreshChat(target, inherited).fresh, false);
});

// ---------------- 生命周期（控制器 + 桩上下文） ----------------

function makeController({ chat, personaKey = 'p_a.png', name1 = P, settingsPatch = {}, saveImpl } = {}) {
    const settings = { enabled: true, injectContext: true, rpgMode: true, sendRpgBars: true, sendRpgSkills: true, sendRpgStronghold: true, sendItems: true, ...settingsPatch };
    const state = { stops: 0, saves: 0, toasts: [], activeKey: personaKey };
    const ctx = { chat, chatMetadata: {}, name1, name2: 'GM', chatId: 'c1', getCurrentChatId: () => ctx.chatId };
    ctx.saveMetadata = saveImpl ? (() => saveImpl(ctx, state)) : (async () => { state.saves++; });
    const ctl = createPersonaController({
        getContext: () => ctx, getSettings: () => settings, saveSettings: () => {}, horaeManager,
        t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k), showToast: (m, type) => state.toasts.push([type, m]),
        escapeHtml: (s) => s, isLightMode: () => false, refreshAllDisplays: () => {}, onSettingsChanged: () => {},
        stopGeneration: () => { state.stops++; }, chatKey: () => `::${ctx.chatId}`,
        getActivePersonaKey: () => state.activeKey, getPersonaName: (k) => (k ? '测试玩家' : ''), listPersonas: () => [], getPersonaAvatarUrl: () => '',
    });
    setup(chat).name1 = name1;
    horaeManager.setBootstrapProvider(() => ctx.chatMetadata[pb.PB_META_KEY]);
    return { ctl, ctx, settings, state };
}

test('lifecycle: fresh chat + enabled profile → one baseline before the request, zero LLM calls; duplicates converge', async () => {
    const chat = [msg('开场白。'), msg('开始', { user: true })];
    const { ctl, ctx, state } = makeController({ chat });
    assert.ok(ctl.saveProfile('p_a.png', fixtureProfile()).ok);
    await Promise.all([ctl.preflight('normal', false), ctl.preflight('normal', false), ctl.preflight('swipe', false)]);
    const rec = ctx.chatMetadata[pb.PB_META_KEY];
    assert.equal(rec.status, pb.PB_STATUS.APPLIED);
    assert.equal(rec.owner, P);
    assert.equal(rec.personaKey, 'p_a.png');
    assert.equal(state.saves, 1);
    assert.equal(state.stops, 0);
    const commitId = rec.commitId;
    await ctl.preflight('regenerate', false); // 生成失败后的重试：复用同一基线
    assert.equal(ctx.chatMetadata[pb.PB_META_KEY].commitId, commitId);
    assertFullBaseline();
    assert.equal(Object.keys(items()).length, 3, 'one effective copy of each item');
    assert.equal(ctl.chatStatus().state, 'initialized');
});

test('lifecycle: disabled profile, dry run, quiet and impersonate have no side effects', async () => {
    const chat = [msg('开场白。'), msg('开始', { user: true })];
    const { ctl, ctx, state } = makeController({ chat });
    ctl.saveProfile('p_a.png', { ...fixtureProfile(), enabled: false });
    await ctl.preflight('normal', false);
    assert.equal(ctx.chatMetadata[pb.PB_META_KEY], undefined);
    ctl.saveProfile('p_a.png', fixtureProfile());
    await ctl.preflight('normal', true);
    await ctl.preflight('quiet', false);
    await ctl.preflight('impersonate', false);
    assert.equal(ctx.chatMetadata[pb.PB_META_KEY], undefined);
    assert.equal(state.saves, 0);
});

test('lifecycle: invalid profile or missing prerequisite → visible failure, generation stopped, nothing written', async () => {
    const chat = [msg('开场白。'), msg('开始', { user: true })];
    const a = makeController({ chat, settingsPatch: { rpgMode: false } });
    a.ctl.saveProfile('p_a.png', fixtureProfile());
    await a.ctl.preflight('normal', false);
    assert.equal(a.ctx.chatMetadata[pb.PB_META_KEY], undefined);
    assert.equal(a.state.stops, 1);
    assert.ok(a.state.toasts.some(([type]) => type === 'error'));
    assert.equal(a.ctl.chatStatus().state, 'prereqMissing');

    const b = makeController({ chat });
    b.ctl.saveProfile('p_a.png', fixtureProfile());
    b.ctl.getProfile('p_a.png').bars[0].current = 999; // 存储被外部改坏
    await b.ctl.preflight('normal', false);
    assert.equal(b.ctx.chatMetadata[pb.PB_META_KEY], undefined);
    assert.equal(b.state.stops, 1);
});

test('lifecycle: save failure leaves no success marker; chat switch during save never writes elsewhere', async () => {
    const chat = [msg('开场白。'), msg('开始', { user: true })];
    const a = makeController({ chat, saveImpl: async () => { throw new Error('disk full'); } });
    a.ctl.saveProfile('p_a.png', fixtureProfile());
    await a.ctl.preflight('normal', false);
    assert.equal(a.ctx.chatMetadata[pb.PB_META_KEY], undefined);
    assert.equal(a.state.stops, 1);
    assert.equal(a.ctl.chatStatus().state, 'failed');

    // 保存期间切换到另一个聊天：新聊天绝不会收到旧模板
    const b = makeController({
        chat,
        saveImpl: async (ctx, state) => { state.saves++; ctx.chatMetadata = {}; ctx.chatId = 'c2'; },
    });
    b.ctl.saveProfile('p_a.png', fixtureProfile());
    const oldMeta = b.ctx.chatMetadata;
    await b.ctl.preflight('normal', false);
    assert.equal(b.ctx.chatId, 'c2');
    assert.equal(b.ctx.chatMetadata[pb.PB_META_KEY], undefined, 'the newly selected chat is untouched');
    assert.equal(oldMeta[pb.PB_META_KEY]?.chatKey, '::c1', 'the record belongs to the chat it was created for');
});

test('lifecycle: old transcript is not seeded; same display name, different keys → separate templates', async () => {
    const chat = [msg('开场白。'), msg('a', { user: true }), msg('旧剧情。')];
    const { ctl, ctx, state } = makeController({ chat });
    ctl.saveProfile('p_a.png', fixtureProfile());
    await ctl.preflight('normal', false);
    assert.equal(ctx.chatMetadata[pb.PB_META_KEY], undefined);
    assert.equal(state.saves, 0);
    assert.equal(ctl.chatStatus().state, 'notEligible');

    const other = { ...fixtureProfile(), bars: [{ key: 'hp', name: '生命', current: 5, max: 5 }] };
    ctl.saveProfile('p_b.png', other);
    assert.equal(ctl.getProfile('p_a.png').bars[0].current, 100);
    assert.equal(ctl.getProfile('p_b.png').bars[0].current, 5);
    assert.notEqual(ctl.getProfile('p_a.png'), ctl.getProfile('p_b.png'));
});

test('lifecycle: editing the template later does not change an initialized chat; Persona switch shows mismatch, no reseed', async () => {
    const chat = [msg('开场白。'), msg('开始', { user: true })];
    const { ctl, ctx, state } = makeController({ chat });
    ctl.saveProfile('p_a.png', fixtureProfile());
    await ctl.preflight('normal', false);
    const rev = ctx.chatMetadata[pb.PB_META_KEY].revision;
    const edited = fixtureProfile();
    edited.bars[0].current = 1;
    const r = ctl.saveProfile('p_a.png', edited);
    assert.equal(r.normalized.revision, rev + 1);
    assert.deepEqual(bars().hp.slice(0, 2), [100, 100], 'frozen baseline');
    state.activeKey = 'p_b.png';
    await ctl.preflight('normal', false);
    const st = ctl.chatStatus();
    assert.equal(st.state, 'initialized');
    assert.equal(st.mismatch, true);
    assert.equal(ctx.chatMetadata[pb.PB_META_KEY].owner, P);
    assert.equal(state.saves, 1);
});

test('lifecycle: explicit clear-all records an opt-out; manual re-initialize is deliberate', async () => {
    const chat = [msg('开场白。'), msg('开始', { user: true })];
    const { ctl, ctx } = makeController({ chat });
    ctl.saveProfile('p_a.png', fixtureProfile());
    await ctl.preflight('normal', false);
    for (const m of chat) delete m.horae_meta;
    ctl.markCleared();
    assert.equal(ctx.chatMetadata[pb.PB_META_KEY].status, pb.PB_STATUS.CLEARED);
    await ctl.preflight('normal', false);
    assert.equal(ctx.chatMetadata[pb.PB_META_KEY].status, pb.PB_STATUS.CLEARED, 'no surprise restoration on next send');
    assert.deepEqual(items(), {});
    globalThis.confirm = () => true;
    await ctl.initializeNow();
    assert.equal(ctx.chatMetadata[pb.PB_META_KEY].status, pb.PB_STATUS.APPLIED);
    assertFullBaseline();
});

test('export/import round-trip keeps text and excludes runtime state', () => {
    const v = pb.validateProfile(fixtureProfile());
    const json = pb.exportProfileJson(v.normalized);
    assert.doesNotMatch(json, /apiKey|personaKey|revision/);
    const back = pb.parseProfileJson(json);
    assert.ok(back.ok);
    const v2 = pb.validateProfile({ ...back.draft, enabled: true });
    assert.ok(v2.ok);
    assert.equal(v2.normalized.items[0].description, KEY_DESC);
    assert.equal(pb.parseProfileJson('{"x":1}').code, 'importNotProfile');
    assert.equal(pb.parseProfileJson('nope').code, 'importNotJson');
});

test('metadata mode: no message text changes across all baseline operations', () => {
    const chat = [msg('开场白。'), msg('开始', { user: true }), msg('第一幕。')];
    const before = chat.map(m => m.mes);
    seeded(chat);
    commit(chat, 2, parse(`<horaerpg>\nhp:${P}=60/100\n</horaerpg>`));
    rebuildAll();
    horaeManager.generateCompactPrompt(0);
    assert.deepEqual(chat.map(m => m.mes), before);
    void createEmptyMeta;
});
