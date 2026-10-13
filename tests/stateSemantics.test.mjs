/**
 * 后台分析提交语义测试：使用真实 horaeManager（parseHoraeTag / applyParsedToMessage / rebuild*）
 * 与 index.js 共用的 applyAnalysisResult，验证验收场景中的数据层行为。
 * 运行：node --test tests/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horaeManager, createEmptyMeta, bg, msg, setup, parse, commit, rebuildAll } from './helpers.mjs';

const U = '尤丝蒂娜';

/** 构造：开场 + 一回合 HP=96/100 的已分析状态 */
function baseChat() {
    const chat = [
        msg('【开场】冬木市的夜晚。'),
        msg('我走进教会。', { user: true }),
        msg('你推开沉重的木门，教会里只有烛光。'),
    ];
    setup(chat);
    commit(chat, 2, parse(`<horae>\ntime:2004/2/1 21:00\nlocation:冬木市·教会\ncharacters:${U},言峰绮礼\n</horae>\n<horaeevent>\nevent:一般|${U}进入教会\n</horaeevent>\n<horaerpg>\nhp:${U}=96/100(HP)\n</horaerpg>`));
    return chat;
}

function push(chat, user, reply) {
    chat.push(msg(user, { user: true }));
    chat.push(msg(reply));
    return chat.length - 1;
}

const hp = () => horaeManager.getRpgData().bars?.[U]?.hp?.slice(0, 2);

test('scenario 1/16: commits never touch message.mes', () => {
    const chat = baseChat();
    const before = chat.map(m => m.mes);
    const idx = push(chat, '我拔出短剑。', '短剑在烛光下闪着寒光。');
    commit(chat, idx, parse('<horaerpg>\nhp:尤丝蒂娜=90/100\n</horaerpg>'));
    commit(chat, idx, parse('<horaenochange/>'));
    assert.deepEqual(chat.slice(0, 3).map(m => m.mes), before);
    assert.equal(chat[idx].mes, '短剑在烛光下闪着寒光。');
    for (const m of chat) assert.ok(!/<horae/i.test(m.mes));
});

test('scenario 2: HP 96 -> 84 on damage; dialogue-only turn does not damage again', () => {
    const chat = baseChat();
    assert.deepEqual(hp(), [96, 100]);
    const i1 = push(chat, '我挡在神父面前。', '黑键擦过你的肩膀，你失去了 12 点生命。');
    commit(chat, i1, parse(`<horaerpg>\nhp:${U}=84/100\n</horaerpg>\n<horaeevent>\nevent:重要|${U}被黑键擦伤\n</horaeevent>`));
    assert.deepEqual(hp(), [84, 100]);
    const i2 = push(chat, '“你是谁？”', '神父只是微笑，没有回答。');
    commit(chat, i2, parse('<horaenochange/>'));
    assert.deepEqual(hp(), [84, 100]);
    // 模型在无变化回合重复报告了当前绝对值：也不会再扣血
    const i3 = push(chat, '我再问一次。', '神父依旧沉默。');
    commit(chat, i3, parse(`<horaerpg>\nhp:${U}=84/100\n</horaerpg>`));
    assert.deepEqual(hp(), [84, 100]);
    // 整体重放后仍正确（模拟重新加载后的 rebuild）
    rebuildAll();
    assert.deepEqual(hp(), [84, 100]);
});

test('scenario 3: skill acquire / upgrade keeps details; unchanged turns do not duplicate', () => {
    const chat = baseChat();
    const i1 = push(chat, '我尝试回路。', '魔术回路第一次运转。');
    commit(chat, i1, parse(`<horaerpg>\nskill:${U}|强化魔术|Lv1|强化物体硬度\n</horaerpg>`));
    const i2 = push(chat, '继续练习。', '你的强化更加稳定。');
    commit(chat, i2, parse(`<horaerpg>\nskill:${U}|强化魔术|Lv2|强化物体硬度，可作用于自身\n</horaerpg>`));
    for (let k = 0; k < 10; k++) {
        const ik = push(chat, `闲聊${k}`, `平静的对话${k}`);
        commit(chat, ik, parse('<horaenochange/>'));
    }
    rebuildAll();
    const skills = horaeManager.getRpgData().skills[U];
    assert.equal(skills.length, 1);
    assert.equal(skills[0].level, 'Lv2');
    assert.match(skills[0].desc, /可作用于自身/);
});

test('scenario 4: inventory pick up, move to bag, hand to NPC, lose — no duplicate acquisition', () => {
    const chat = baseChat();
    const i1 = push(chat, '我捡起地上的徽章。', '你捡起了一枚银色徽章。');
    commit(chat, i1, parse(`<horae>\nitem!:🏅银色徽章|刻有十字的银色徽章=${U}@手中\n</horae>`));
    const i2 = push(chat, '我把徽章放进包里。', '徽章被收进了背包。');
    commit(chat, i2, parse(`<horae>\nitem:🏅银色徽章=${U}@背包\n</horae>`));
    let items = horaeManager.getLatestState().items;
    assert.equal(Object.keys(items).length, 1);
    assert.equal(items['银色徽章'].location, '背包');
    assert.match(items['银色徽章'].description, /十字/);
    const i3 = push(chat, '我把徽章交给神父。', '言峰绮礼接过徽章。');
    commit(chat, i3, parse('<horae>\nitem:🏅银色徽章=言峰绮礼@言峰绮礼手中\n</horae>'));
    items = horaeManager.getLatestState().items;
    assert.equal(items['银色徽章'].holder, '言峰绮礼');
    const i4 = push(chat, '……', '徽章被神父扔进了火盆，化为灰烬。');
    commit(chat, i4, parse('<horae>\nitem-:银色徽章\n</horae>'));
    items = horaeManager.getLatestState().items;
    assert.equal(Object.keys(items).length, 0);
});

test('scenario 4b: equip an existing item via RPG equipment', () => {
    const chat = baseChat();
    const i1 = push(chat, '我拿起短剑。', '你握住了短剑。');
    commit(chat, i1, parse(`<horae>\nitem:🗡️短剑=${U}@手中\n</horae>`));
    const i2 = push(chat, '我把短剑佩在腰间。', '短剑被挂在腰带上。');
    commit(chat, i2, parse(`<horaerpg>\nequip:${U}|武器|短剑|atk=5\n</horaerpg>`));
    const eq = horaeManager.getRpgData().equipment?.[U];
    assert.ok(eq?.['武器']?.some(e => e.name === '短剑'));
});

test('scenario 5: NPC register / update; mentioning without change keeps facts', () => {
    const chat = baseChat();
    const i1 = push(chat, '“神父先生？”', '高大的神父转过身来。');
    commit(chat, i1, parse(`<horae>\nnpc:言峰绮礼|黑色神父服/高大=深不可测@教会的神父~性别:男~年龄:约28~职业:神父\naffection:言峰绮礼=20\nrel:言峰绮礼>${U}=监视者\n</horae>`));
    const i2 = push(chat, '我向他道谢。', '神父点头。');
    commit(chat, i2, parse('<horae>\naffection:言峰绮礼=30\nnpc:言峰绮礼|=@似乎对尤丝蒂娜感兴趣的神父\n</horae>'));
    const i3 = push(chat, '我提到了神父。', '你想起刚才神父的话。');
    commit(chat, i3, parse('<horaenochange/>'));
    const st = horaeManager.getLatestState();
    assert.equal(st.affection['言峰绮礼'], 30);
    assert.match(st.npcs['言峰绮礼'].appearance, /黑色神父服/);
    assert.match(st.npcs['言峰绮礼'].relationship, /感兴趣/);
    assert.ok(horaeManager.getRelationships().some(r => r.from === '言峰绮礼' && r.type === '监视者'));
});

test('scenario 6/7: scene, story time, events; idle turn keeps date', () => {
    const chat = baseChat();
    const i1 = push(chat, '我们去地下室。', '石阶通向地下室。夜更深了。');
    commit(chat, i1, parse('<horae>\ntime:2004/2/1 23:30\nlocation:冬木市·教会·地下室\ncharacters:尤丝蒂娜\n</horae>\n<horaeevent>\nevent:重要|尤丝蒂娜独自进入地下室\n</horaeevent>'));
    const i2 = push(chat, '“好冷。”', '你的声音在石壁间回响。');
    commit(chat, i2, parse('<horaenochange/>'));
    const st = horaeManager.getLatestState();
    assert.equal(st.timestamp.story_date, '2004/2/1');
    assert.equal(st.timestamp.story_time, '23:30');
    assert.equal(st.scene.location, '冬木市·教会·地下室');
    assert.deepEqual(st.scene.characters_present, [U]);
    const events = horaeManager.getEvents();
    assert.ok(events.some(e => /地下室/.test(e.event.summary)));
    // 下一回合注入（只读快照）包含最新场景与时间
    const prompt = horaeManager.generateCompactPrompt(0);
    assert.match(prompt, /地下室/);
    assert.match(prompt, /23:30/);
});

test('scenario 8: no-change turn is recorded as analyzed with no invented data', () => {
    const chat = baseChat();
    const i1 = push(chat, '“晚上好。”', '“晚上好。”神父回应。');
    commit(chat, i1, parse('<horaenochange/>'));
    const meta = chat[i1].horae_meta;
    assert.equal(meta._bg.status, bg.BG_STATUS.NO_CHANGE);
    assert.ok(bg.isMessageAnalyzed(chat[i1]));
    assert.equal(meta.timestamp.story_date, '');
    assert.equal(meta.scene.location, '');
    assert.deepEqual(meta.events, []);
    assert.equal(meta._rpgChanges, undefined);
});

test('scenario 11: swipe — old swipe damage stops applying when new swipe has none', () => {
    const chat = baseChat();
    const i1 = push(chat, '我冲上前去。', '旧版本：你被击中，失去 30 点生命。');
    chat[i1].swipes = [chat[i1].mes];
    chat[i1].swipe_id = 0;
    commit(chat, i1, parse(`<horaerpg>\nhp:${U}=66/100\n</horaerpg>`));
    assert.deepEqual(hp(), [66, 100]);
    // 切换到新 swipe：index.js 会把该楼层元数据重置为空（或从缓存恢复），并从全部楼层重放
    chat[i1].swipes.push('新版本：你灵巧地躲开了攻击。');
    chat[i1].swipe_id = 1;
    chat[i1].mes = chat[i1].swipes[1];
    chat[i1].horae_meta = createEmptyMeta();
    rebuildAll();
    assert.deepEqual(hp(), [96, 100], 'HP rolls back as soon as the old swipe is deselected');
    commit(chat, i1, parse('<horaenochange/>'));
    assert.deepEqual(hp(), [96, 100]);
});

test('scenario 12: edit replaces the message delta (no stacking); delete revokes it', () => {
    const chat = baseChat();
    const i1 = push(chat, '我打开箱子。', '箱子里有一瓶药水。');
    commit(chat, i1, parse(`<horae>\nitem:🧪治疗药水=${U}@背包\n</horae>\n<horaerpg>\nskill:${U}|开锁|Lv1|\n</horaerpg>`));
    const i2 = push(chat, '我喝下药水。', '你感到温暖。');
    commit(chat, i2, parse(`<horaerpg>\nhp:${U}=100/100\n</horaerpg>`));
    // 编辑较早楼层 i1：重新分析结果替换旧增量
    chat[i1].mes = '箱子里有两瓶药水。';
    commit(chat, i1, parse(`<horae>\nitem:🧪治疗药水(2瓶)=${U}@背包\n</horae>\n<horaerpg>\nskill:${U}|开锁|Lv1|\n</horaerpg>`));
    const st = horaeManager.getLatestState();
    assert.deepEqual(Object.keys(st.items), ['治疗药水(2瓶)']);
    assert.equal(horaeManager.getRpgData().skills[U].length, 1);
    assert.deepEqual(hp(), [100, 100], 'later state still applied after rebuild');
    // 删除楼层 i2（ST 删除后 index.js 走 rebuild）
    chat.splice(i2 - 1, 2);
    rebuildAll();
    assert.deepEqual(hp(), [96, 100]);
});

test('scenario 15: group chat — consecutive AI replies update one shared state without duplicate items', () => {
    const chat = baseChat();
    chat.push(msg('我向两人举杯。', { user: true }));
    chat.push(msg('GM：酒馆里一片欢腾。', { name: 'GM' }));
    chat.push(msg('Saber：她也举起了杯子。', { name: 'Saber' }));
    // 第一条 AI 回复结算 USER 行动
    commit(chat, chat.length - 2, parse(`<horae>\nitem:🍺麦酒=${U}@手中\n</horae>`));
    commit(chat, chat.length - 1, parse('<horae>\nitem:🍺麦酒=Saber@手中\n</horae>'));
    const st = horaeManager.getLatestState();
    // 同名物品更新持有者而不是重复登记
    assert.equal(Object.keys(st.items).filter(k => k.includes('麦酒')).length, 1);
});

test('scenario 16: manual HUD edit survives re-analysis of the same message', () => {
    const chat = baseChat();
    const i1 = push(chat, '战斗。', '你受了伤。');
    commit(chat, i1, parse(`<horaerpg>\nhp:${U}=70/100\n</horaerpg>`));
    // index.js commitRpgEdit 在 Metadata 模式下写 _rpgChanges + _manualRpgEdits
    const meta = chat[i1].horae_meta;
    meta._rpgChanges.bars[U].hp = [75, 100, ''];
    meta._manualRpgEdits = { bars: { [U]: { hp: [75, 100, ''] } } };
    horaeManager.rebuildRpgData();
    assert.deepEqual(hp(), [75, 100]);
    // 重新分析该楼层（例如正文被编辑）：手动值优先
    commit(chat, i1, parse(`<horaerpg>\nhp:${U}=70/100\n</horaerpg>`));
    assert.deepEqual(hp(), [75, 100]);
    assert.equal(chat[i1].mes, '你受了伤。');
});

test('commit preserves chat[0] global data and summary flags via preserve hook', () => {
    const chat = baseChat();
    chat[0].horae_meta.autoSummaries = [{ id: 's1', active: true }];
    // 对 chat[0]（开场白）做分析时，全局数据需通过 preserve 钩子保留
    const job = { fp: bg.fingerprintText(chat[0].mes), swipeId: 0 };
    bg.applyAnalysisResult(horaeManager, 0, parse('<horae>\nlocation:冬木市\n</horae>'), job, {
        preserve: (old) => {
            const saved = { autoSummaries: old.autoSummaries, rpg: old.rpg };
            return (meta) => Object.assign(meta, saved);
        },
    });
    assert.deepEqual(chat[0].horae_meta.autoSummaries, [{ id: 's1', active: true }]);
    assert.equal(chat[0].horae_meta.scene.location, '冬木市');
});

// ---------- 主模型提示词隔离（场景 20） ----------

test('scenario 20: metadata mode — main prompt has state but no tag-output instructions', () => {
    const chat = baseChat();
    setup(chat, { stateMode: 'metadata' });
    const compact = horaeManager.generateCompactPrompt(0);
    const rules = horaeManager.generateSystemPromptAddition();
    assert.equal(rules, '');
    assert.match(compact, /冬木市·教会/);
    assert.match(compact, /96/);
    assert.doesNotMatch(compact, /<horae/i);
    assert.doesNotMatch(compact, /输出/);
});

test('scenario 20: analyzer state snapshot excludes the target message and is read-only', () => {
    const chat = baseChat();
    const i1 = push(chat, '我受伤。', '你失去 12 点生命。');
    commit(chat, i1, parse(`<horaerpg>\nhp:${U}=84/100\n</horaerpg>`));
    const snapshot = horaeManager.generateCompactPrompt(chat.length - i1, { audience: 'analyzer' });
    assert.match(snapshot, /96/);
    assert.doesNotMatch(snapshot, /84\/100/);
    assert.doesNotMatch(snapshot, /<horae>/);
    const modules = horaeManager.generateBgModulePrompts();
    assert.match(modules, /<horaerpg>/, 'analyzer receives RPG format reference');
});

test('scenario 18: legacy mode keeps tag instructions and inline parsing', () => {
    const chat = [msg('开场'), msg('行动', { user: true }), msg('剧情正文\n<horae>\nlocation:旧模式地点\n</horae>\n<horaerpg>\nhp:尤丝蒂娜=50/100\n</horaerpg>')];
    setup(chat, { stateMode: 'legacy' });
    const rules = horaeManager.generateSystemPromptAddition();
    assert.match(rules, /<horae>/);
    assert.match(horaeManager.generateCompactPrompt(0), /<horae>/);
    horaeManager.processAIResponse(2, chat[2].mes);
    assert.equal(chat[2].horae_meta.scene.location, '旧模式地点');
    assert.deepEqual(horaeManager.getRpgData().bars[U].hp.slice(0, 2), [50, 100]);
});

test('scenario 12b: re-analysis after edit revokes the old delta (damage removed)', () => {
    const chat = baseChat();
    const i1 = push(chat, '我冲上前。', '你被砍中，失去 46 点生命。');
    commit(chat, i1, parse(`<horaerpg>\nhp:${U}=50/100\n</horaerpg>\n<horae>\nitem:🩸染血的布条=${U}@手中\n</horae>`));
    const i2 = push(chat, '我后退。', '你退到墙边。');
    commit(chat, i2, parse('<horaenochange/>'));
    assert.deepEqual(hp(), [50, 100]);
    // 用户把 i1 改成「躲开了」，重新分析无变化 → 伤害与物品都应撤销
    chat[i1].mes = '你灵巧地躲开了。';
    commit(chat, i1, parse('<horaenochange/>'));
    assert.deepEqual(hp(), [96, 100]);
    assert.equal(Object.keys(horaeManager.getLatestState().items).length, 0);
});

test('regression: chat without greeting where chat[0].rpg only holds configs', () => {
    // chat[0] 是用户消息，且 rpg 由配置写入路径创建为 {}（无 bars/status/skills）
    const chat = [msg('第一句就是用户行动。', { user: true }), msg('你被划伤，失去 5 点生命。')];
    setup(chat);
    chat[0].horae_meta.rpg = { equipmentConfig: { locked: false, perChar: {} } };
    commit(chat, 1, parse(`<horaerpg>\nhp:${U}=95/100\n</horaerpg>`));
    assert.deepEqual(hp(), [95, 100]);
});

test('analyzer RPG format reference has no "every turn / every present character" mandate', () => {
    for (const lang of ['zh-CN', 'en', 'ja', 'ko', 'ru']) {
        setup([msg('g')], { aiOutputLanguage: lang });
        const gm = horaeManager.generateRpgPrompt();
        const an = horaeManager.generateBgModulePrompts();
        assert.match(gm, /<horaerpg>/);
        assert.match(an, /<horaerpg>/, `${lang}: analyzer still gets the RPG format`);
        assert.doesNotMatch(an, /每回合必写|required every turn|毎ターン必須|매 턴 필수|обязательны каждый ход/, `${lang}: header adapted`);
        assert.doesNotMatch(an, /MUST still write current values|也必须写出当前值|現在の値を必ず記載|현재 값을 반드시 기재|НЕОБХОДИМО записать текущие значения/, `${lang}: unchanged-values rule removed`);
        assert.doesNotMatch(an, /末尾必须包含<horaerpg>|MUST include a <horaerpg> tag at the end/, `${lang}: end-of-reply mandate removed`);
    }
    // 主模型（旧版）提示词保持原样
    setup([msg('g')], { aiOutputLanguage: 'zh-CN', stateMode: 'legacy' });
    assert.match(horaeManager.generateRpgPrompt(), /每回合必写/);
});

test('greeting (#0) re-analysis keeps chat-wide data; swipe cache holds only per-message delta', () => {
    const chat = [msg('开场：你站在冬木市的桥上。'), msg('我四处张望。', { user: true }), msg('远处传来钟声。')];
    setup(chat);
    const first = chat[0].horae_meta;
    first.customTables = [{ name: '任务表', rows: 2, cols: 2, data: { '0-0': '任务' } }];
    first._otherExtensionData = { x: 1 };
    first.autoSummaries = [{ id: 's1', active: true }];
    first.agenda = [{ text: '用户待办', source: 'user', date: '' }];
    first._rpgConfigs = { currencyConfig: { denominations: [{ name: '金币' }] } };
    commit(chat, 2, parse(`<horaerpg>\nhp:${U}=90/100\n</horaerpg>`));
    const rpgBefore = JSON.stringify(chat[0].horae_meta.rpg.bars);

    const hooks = { preserve: (old) => { const saved = bg.saveChatWideMeta(old); return (meta) => bg.restoreChatWideMeta(meta, saved); } };
    const job = { fp: bg.fingerprintText(chat[0].mes), swipeId: 0 };
    bg.applyAnalysisResult(horaeManager, 0, parse('<horae>\nlocation:冬木大桥\nagenda:2004/2/1|调查钟声\n</horae>'), job, hooks);
    const m0 = chat[0].horae_meta;
    assert.equal(m0.scene.location, '冬木大桥');
    assert.equal(m0.customTables[0].name, '任务表');
    assert.deepEqual(m0._otherExtensionData, { x: 1 });
    assert.deepEqual(m0.autoSummaries, [{ id: 's1', active: true }]);
    assert.ok(m0.agenda.some(a => a.text === '用户待办'));
    assert.ok(m0.agenda.some(a => a.text === '调查钟声'));
    assert.equal(m0._rpgConfigs.currencyConfig.denominations[0].name, '金币');
    assert.equal(JSON.stringify(m0.rpg.bars), rpgBefore, 'rpg aggregate rebuilt to the same values');
    assert.deepEqual(hp(), [90, 100]);

    const delta = bg.pickMessageDelta(m0);
    assert.equal(delta.scene.location, '冬木大桥');
    for (const k of ['rpg', 'customTables', 'autoSummaries', '_rpgConfigs', '_otherExtensionData']) assert.equal(delta[k], undefined, k);
});

test('analyzer default prompts restate scene basics every time; other fields stay incremental', () => {
    for (const p of [bg.DEFAULT_BG_PROMPT_ZH, bg.DEFAULT_BG_PROMPT_EN]) {
        assert.match(p, /time:[^\n]*(每次都写|every time)/);
        assert.match(p, /location:[^\n]*(每次都写|every time)/);
        assert.match(p, /characters:[^\n]*(每次都写|every time)/);
        assert.match(p, /costume:[^\n]*(每次都写|every time)/);
        assert.match(p, /item:[^\n]*(新获得|newly obtained)/, 'items remain change-driven');
        assert.match(p, /affection:[^\n]*(仅变化|only on change)/, 'affection remains change-driven');
        assert.doesNotMatch(p, /time:[^\n]*(仅变化时|only if changed)/);
    }
});

test('getInheritedScene returns the scene established before a message, read-only', () => {
    const chat = baseChat();
    const idx = push(chat, '我坐下。', '烛火摇曳。');
    commit(chat, idx, parse('<horaeevent>\nevent:一般|坐下\n</horaeevent>'));
    chat[2].horae_meta.costumes = { [U]: '黑色风衣' };
    const before = JSON.stringify(chat[idx].horae_meta);

    const inh = horaeManager.getInheritedScene(idx);
    assert.equal(inh.story_date, '2004/2/1');
    assert.equal(inh.story_time, '21:00');
    assert.equal(inh.location, '冬木市·教会');
    assert.deepEqual(inh.characters_present, [U, '言峰绮礼']);
    assert.deepEqual(inh.costumes, { [U]: '黑色风衣' });
    assert.equal(JSON.stringify(chat[idx].horae_meta), before, 'message meta untouched');
    assert.equal(chat[idx].horae_meta.scene.location, '');

    // 不含本楼层自身；跳过番外楼层
    chat[2].horae_meta._skipHorae = true;
    assert.equal(horaeManager.getInheritedScene(idx).location, '');
    assert.equal(horaeManager.getInheritedScene(0).location, '');
});

test('analyzer default prompts say the speaker may be a narrator and must not absorb NPC data', () => {
    assert.match(bg.DEFAULT_BG_PROMPT_ZH, /\{\{speaker\}\}」只是写出这条回复的角色卡名称/);
    assert.match(bg.DEFAULT_BG_PROMPT_EN, /"\{\{speaker\}\}" is only the name of the card/);
});

test('analyzer prompts: affection is a judgment with starting values; relationships evolve from the existing base', () => {
    const zh = bg.DEFAULT_BG_PROMPT_ZH, en = bg.DEFAULT_BG_PROMPT_EN;
    assert.doesNotMatch(zh, /虚构时间、服装、好感度/, 'rule 3 no longer forbids affection');
    assert.doesNotMatch(en, /time, outfit, affection score/);
    assert.match(zh, /陌生0-20 \/ 熟人30-50 \/ 朋友50-70 \/ 恋人70-90/);
    assert.match(en, /stranger 0-20 \/ acquaintance 30-50 \/ friend 50-70 \/ lover 70-90/);
    assert.match(zh, /已有的关系是基础，本条回复只是修正/);
    assert.match(zh, /临时身份（护卫、雇主、向导、队友等）/);
    assert.match(zh, /“近期”按故事内的常识理解/);
    assert.match(en, /The relationship already in \[Current State\] is the base/);
    assert.match(en, /recent in story time by common sense/);
});

test('analyzer snapshot shows the whole relationship network; the GM only sees present characters', () => {
    const chat = [msg('开场'), msg('嗨', { user: true }), msg('你们在酒馆。')];
    setup(chat, { sendRelationships: true });
    commit(chat, 2, parse(`<horae>\ncharacters:${U}\nrel:${U}>艾琳=恋人|一起逃离王都\n</horae>`));
    const an = horaeManager.generateCompactPrompt(0, { audience: 'analyzer' });
    const gm = horaeManager.generateCompactPrompt(0, { audience: 'main' });
    assert.ok(an.includes(`${U}→艾琳: 恋人(一起逃离王都)`), an);
    assert.ok(gm.includes(`${U}→艾琳: 恋人`), 'GM sees relationships of present characters');
    // 两个都不在场的角色：只有分析器看得到
    commit(chat, 2, parse(`<horae>\ncharacters:${U}\nrel:伊凡>艾琳=兄妹\n</horae>`));
    assert.ok(horaeManager.generateCompactPrompt(0, { audience: 'analyzer' }).includes('伊凡→艾琳: 兄妹'));
    assert.ok(!horaeManager.generateCompactPrompt(0, { audience: 'main' }).includes('伊凡→艾琳'));
});

test('hand-edited relationships are a base, not a lock: later analyses evolve them and rebuilds keep them', () => {
    const chat = [msg('开场'), msg('嗨', { user: true }), msg('你们在酒馆。')];
    setup(chat, { sendRelationships: true });
    // 用户手动设定（或继承）的关系：消息中没有对应记录，只存在于聚合中
    chat[0].horae_meta.relationships = [{ from: U, to: '艾琳', type: '恋人', note: '', _userEdited: true }];
    horaeManager.rebuildRelationships();
    assert.equal(horaeManager.getRelationships()[0].type, '恋人', 'kept as base on rebuild');

    const idx = push(chat, '我们出发吧。', '你护送艾琳穿过森林。');
    commit(chat, idx, parse(`<horae>\nrel:${U}>艾琳=恋人；本次任务中由${U}护送|护送艾琳穿越森林\n</horae>`));
    horaeManager.rebuildRelationships();
    const r = horaeManager.getRelationships().find(x => x.from === U && x.to === '艾琳');
    assert.equal(r.type, `恋人；本次任务中由${U}护送`, 'later analysis evolves the edited pair');
    assert.equal(r.note, '护送艾琳穿越森林');
    assert.ok(r._userEdited, 'still survives rebuilds as a base');
});
