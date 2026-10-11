/**
 * 真实 SillyTavern + Horae 端到端测试
 * 前置：ST 运行在 ST_URL；node tests/e2e/mockServer.mjs 运行在 MOCK_URL
 * 运行：PLAYWRIGHT_PATH=<含 playwright 的 package.json> node tests/e2e/run.mjs
 */
import { writeFileSync } from 'node:fs';
import { launch, openST, mock, waitFor, waitBg, chatSnapshot, rpgData, sendUser, check, sleep, waitIdle, currentChatRef, reopenChat, MOCK_URL, ST_URL } from './lib.mjs';

// 扩展目录名随安装方式而变（上游 SillyTavern-Horae / fork SillyTavern-Horae-Metadata）
async function findVectorModuleUrl() {
    for (const folder of [process.env.HORAE_FOLDER, 'SillyTavern-Horae-Metadata', 'SillyTavern-Horae'].filter(Boolean)) {
        const url = `/scripts/extensions/third-party/${folder}/core/vectorManager.js`;
        if ((await fetch(ST_URL + url)).ok) return url;
    }
    throw new Error('Horae extension folder not found on ST server');
}
const VM_URL = await findVectorModuleUrl();

const results = [];
const { browser, page, consoleLines } = await launch({ headless: process.env.HEADED ? false : true });

const AUX_RULES = (user) => [
    { match: '失去了 12 点生命', response: `<horaerpg>\nhp:${user}=84/100\n</horaerpg>\n<horaeevent>\nevent:重要|${user}被黑键擦伤，失去12点生命\n</horaeevent>` },
    { match: '你推开沉重的木门', response: `<horae>\ntime:2004/2/1 21:00\nlocation:冬木市·教会\ncharacters:${user},言峰绮礼\n</horae>\n<horaeevent>\nevent:一般|${user}进入冬木教会\n</horaeevent>\n<horaerpg>\nhp:${user}=96/100(HP)\n</horaerpg>` },
    { match: '你捡起了一枚银色徽章', response: `<horae>\nitem!:🏅银色徽章|刻有十字的银色徽章=${user}@手中\n</horae>` },
    { match: '魔术回路第一次运转', response: `<horaerpg>\nskill:${user}|强化魔术|Lv1|强化物体硬度\n</horaerpg>\n<horaeevent>\nevent:重要|${user}首次成功使用强化魔术\n</horaeevent>` },
    { match: '你被重重击倒，失去 30 点生命', response: `<horaerpg>\nhp:${user}=54/100\n</horaerpg>` },
    { match: '巨石砸中了你，失去 20 点生命', response: `<horaerpg>\nhp:${user}=34/100\n</horaerpg>` },
    { match: '高大的神父转过身来', response: `<horae>\nnpc:言峰绮礼|黑色神父服/高大=深不可测@监视${user}的神父~性别:男~年龄:约28~职业:神父\naffection:言峰绮礼=20\n</horae>` },
    { match: '地下室里一片漆黑', response: `<horae>\ntime:2004/2/1 23:30\nlocation:冬木市·教会·地下室\n</horae>\n<horaeevent>\nevent:重要|${user}进入教会地下室\n</horaeevent>` },
    { match: '群聊-GM：酒馆里一片欢腾', response: `<horae>\nitem:🍺麦酒=${user}@手中\n</horae>` },
];

async function setTextarea(selector, text) {
    await page.fill(selector, text);
}

async function configure() {
    await openST(page);
    const userName = await page.evaluate(() => SillyTavern.getContext().name1);
    // ---- 主 API：Custom OpenAI 兼容 → mock ----
    await page.evaluate(async (mockUrl) => {
        const $ = window.jQuery;
        $('#main_api').val('openai').trigger('change');
        await new Promise(r => setTimeout(r, 300));
        $('#chat_completion_source').val('custom').trigger('change');
        await new Promise(r => setTimeout(r, 300));
        $('#custom_api_url_text').val(mockUrl + '/v1').trigger('input').trigger('change');
        $('#custom_model_id').val('mock-main').trigger('input').trigger('change');
    }, MOCK_URL);
    await page.click('#api_button_openai').catch(() => {});
    await page.waitForTimeout(1500);

    // ---- Horae：辅助 API + RPG + 向量（API embedding → mock） ----
    await page.evaluate((mockUrl) => {
        const s = SillyTavern.getContext().extensionSettings.horae;
        Object.assign(s, {
            auxApiEnabled: true, auxApiUrl: mockUrl + '/v1', auxApiKey: 'test-key', auxApiModel: 'mock-aux',
            auxApiUseForAnalysis: true, auxApiFallbackToMain: false,
            rpgMode: true, sendRpgBars: true, sendRpgSkills: true, sendRpgEquipment: true,
            vectorEnabled: true, vectorSource: 'api', vectorApiUrl: mockUrl + '/v1', vectorApiKey: 'test-key', vectorApiModel: 'mock-embed',
            bgWaitTimeoutSec: 20,
        });
        const set = (id, v) => { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } };
        set('horae-setting-aux-api-enabled', true);
        set('horae-setting-aux-api-url', mockUrl + '/v1');
        set('horae-setting-aux-api-key', 'test-key');
        const sel = document.getElementById('horae-setting-aux-api-model');
        if (sel) {
            if (sel.tagName === 'SELECT' && ![...sel.options].some(o => o.value === 'mock-aux')) {
                const o = document.createElement('option'); o.value = 'mock-aux'; o.textContent = 'mock-aux'; sel.appendChild(o);
            }
            sel.value = 'mock-aux';
        }
        SillyTavern.getContext().saveSettingsDebounced();
    }, MOCK_URL);
    // 本测试面向 Metadata 模式；全新安装默认值与升级迁移由 migration.mjs 单独验证
    await page.evaluate(() => window.jQuery('#horae-setting-state-mode').val('metadata').trigger('change'));
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openST(page);
    return userName;
}

async function newChatWithFirstCharacter(name = 'Seraphina') {
    await page.evaluate(async (name) => {
        const ctx = SillyTavern.getContext();
        let id = ctx.characters.findIndex(c => c.name === name);
        if (id < 0) id = 0;
        if (String(ctx.characterId) !== String(id)) await ctx.selectCharacterById(id);
    }, name);
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
        const m = await import('/script.js');
        await m.doNewChat({ deleteCurrentChat: false });
    });
    await page.waitForTimeout(2500);
}

function noTags(text) {
    return !/<\/?horae|^\s*(time|location|skill|costume|characters):/im.test(String(text || ''));
}

try {
    await mock('/reset', {});
    const U = await configure();
    console.log('user name =', U);
    await mock('/control', { auxRules: AUX_RULES(U), clearLogs: true });

    await newChatWithFirstCharacter();
    // 开场白可能触发一次分析（first_message），等它结束
    await page.waitForTimeout(2000);
    let snap = await chatSnapshot(page);
    check(results, 'setup: new chat with greeting', snap.length >= 1, `chat length ${snap.length}, char ${snap[0]?.name}`);
    const settingsNow = await page.evaluate(() => ({ mode: SillyTavern.getContext().extensionSettings.horae.stateMode, aux: SillyTavern.getContext().extensionSettings.horae.auxApiEnabled, api: SillyTavern.getContext().mainApi }));
    check(results, 'setup: metadata mode active after reload; aux API enabled', settingsNow.mode === 'metadata' && settingsNow.aux, JSON.stringify(settingsNow));

    // ===== 场景 1/2：干净正文 + HP 96 → 84 =====
    const NARR1 = '你推开沉重的木门，冬木教会里只有摇曳的烛光。'.repeat(1) + '长椅整齐排列，祭坛前站着一个高大的身影。'.repeat(30);
    await mock('/control', { mainQueue: [NARR1], clearLogs: true });
    await sendUser(page, '我走进教会。');
    let idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx);
    snap = await chatSnapshot(page);
    check(results, 'S1 clean narrative: mes equals the GM output byte-for-byte', snap[idx].mes === NARR1);
    check(results, 'S1 no tags in any mes', snap.every(m => noTags(m.mes)));
    check(results, 'S1 bg marker done with fingerprint', snap[idx].bg?.status === 'done' && !!snap[idx].bg?.fp, JSON.stringify(snap[idx].bg));
    let logs = await mock('/logs');
    const main1 = logs.find(l => l.type === 'main');
    const mainText = JSON.stringify(main1?.messages || []);
    check(results, 'S20 main request contains no instruction to emit <horae>', main1 && !/<horae/i.test(mainText) && !/horaeevent|horaerpg/i.test(mainText));
    const aux1 = logs.filter(l => l.type === 'aux');
    check(results, 'S20 aux request is separate and contains the story + format spec', aux1.some(a => a.story.includes('你推开沉重的木门') && JSON.stringify(a.messages).includes('<horaerpg>')));
    let rpg = await rpgData(page);
    check(results, 'S2 HP initialised to 96/100', rpg?.bars?.[U]?.hp?.[0] === 96, JSON.stringify(rpg?.bars));

    await mock('/control', { mainQueue: ['黑键擦过你的肩膀，你失去了 12 点生命。言峰绮礼收回了手。'], clearLogs: true });
    await sendUser(page, '我挡在神父面前。');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx);
    rpg = await rpgData(page);
    check(results, 'S2 HP 96 -> 84 after explicit damage', rpg?.bars?.[U]?.hp?.[0] === 84, JSON.stringify(rpg?.bars?.[U]));
    logs = await mock('/logs');
    const main2 = logs.find(l => l.type === 'main');
    check(results, 'S6/S20 next-turn injection carries factual state (HP 96, location)', JSON.stringify(main2?.messages).includes('冬木市·教会') && JSON.stringify(main2?.messages).includes('96'));

    // ===== 场景 8：无变化回合 =====
    await mock('/control', { mainQueue: ['“晚上好。”神父平静地回应，没有其他动作。'], clearLogs: true });
    await sendUser(page, '“晚上好。”');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx);
    snap = await chatSnapshot(page);
    rpg = await rpgData(page);
    check(results, 'S8 no-change turn recorded as nochange', snap[idx].bg?.status === 'nochange');
    check(results, 'S2 dialogue-only turn does not deal damage again', rpg?.bars?.[U]?.hp?.[0] === 84);
    check(results, 'S8 no invented time/location on no-change turn', !snap[idx].meta.timestamp.story_date && !snap[idx].meta.scene.location);

    // ===== 场景 4/3/5：物品、技能、NPC =====
    await mock('/control', { mainQueue: ['你捡起了一枚银色徽章，上面刻着十字。'], clearLogs: true });
    await sendUser(page, '我捡起地上的东西。');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx);
    await mock('/control', { mainQueue: ['魔术回路第一次运转，你成功强化了手中的木棍。'] });
    await sendUser(page, '我尝试使用魔术。');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx);
    await mock('/control', { mainQueue: ['高大的神父转过身来，黑色神父服在烛光下几乎与阴影融为一体。'] });
    await sendUser(page, '“神父先生？”');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx);
    const state1 = await page.evaluate(() => {
        const ctx = SillyTavern.getContext();
        // 通过 Horae 的公开 API 读取聚合状态
        const api = window.HoraeAPI || window.horae || null;
        return { hasApi: !!api, apiKeys: api ? Object.keys(api) : [] };
    });
    console.log('HoraeAPI:', JSON.stringify(state1));
    rpg = await rpgData(page);
    check(results, 'S3 skill registered once with details', rpg?.skills?.[U]?.length === 1 && rpg.skills[U][0].desc.includes('强化'), JSON.stringify(rpg?.skills));
    snap = await chatSnapshot(page);
    const itemsMeta = snap.flatMap(m => Object.keys(m.meta?.items || {}));
    check(results, 'S4 item stored once in metadata', itemsMeta.filter(n => n === '银色徽章').length === 1, JSON.stringify(itemsMeta));
    const npcMeta = snap.find(m => m.meta?.npcs?.['言峰绮礼']);
    check(results, 'S5 NPC registered with affection', !!npcMeta && npcMeta.meta.affection?.['言峰绮礼'], JSON.stringify(npcMeta?.meta?.affection));
    check(results, 'S1 still no tags in any mes after several turns', snap.every(m => noTags(m.mes)));

    // ===== 场景 9：辅助 API 失败 → 状态不动、可见、可重试 =====
    const hpBefore = (await rpgData(page))?.bars?.[U]?.hp?.[0];
    await mock('/control', { mainQueue: ['你被重重击倒，失去 30 点生命。'], auxFailNext: 1, clearLogs: true });
    await sendUser(page, '我冲向黑影。');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx, ['failed']);
    snap = await chatSnapshot(page);
    rpg = await rpgData(page);
    const badge = await page.evaluate((i) => document.querySelector(`.mes[mesid="${i}"] .horae-bg-status`)?.dataset.state, idx);
    check(results, 'S9 API failure leaves state untouched', rpg?.bars?.[U]?.hp?.[0] === hpBefore, `hp ${rpg?.bars?.[U]?.hp?.[0]} vs ${hpBefore}`);
    check(results, 'S9 failure visible on message badge', badge === 'failed', `badge=${badge}`);
    check(results, 'S9 prose intact after failure', snap[idx].mes === '你被重重击倒，失去 30 点生命。');
    await page.click(`.mes[mesid="${idx}"] .horae-bg-status`);
    await waitBg(page, idx);
    rpg = await rpgData(page);
    check(results, 'S9 retry via badge succeeds and applies damage', rpg?.bars?.[U]?.hp?.[0] === 54, JSON.stringify(rpg?.bars?.[U]));

    // 格式错误
    await mock('/control', { mainQueue: ['你喘了口气，靠在墙边。'], auxMalformedNext: 1, clearLogs: true });
    await sendUser(page, '我休息一下。');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx, ['failed']);
    snap = await chatSnapshot(page);
    check(results, 'S9 malformed aux response rejected (no loose parsing)', snap[idx].bg.status === 'failed' && !snap[idx].meta.scene.location, snap[idx].bg.error);

    // ===== 场景 11：swipe =====
    await mock('/control', { mainQueue: ['巨石砸中了你，失去 20 点生命。', '新版本：你灵巧地躲开了巨石，毫发无伤。'], clearLogs: true });
    await sendUser(page, '我穿过坍塌的回廊。');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx);
    const hpAfterHit = (await rpgData(page))?.bars?.[U]?.hp?.[0];
    check(results, 'S11 old swipe applied damage (54 -> 34)', hpAfterHit === 34, `hp ${hpAfterHit}`);
    await page.evaluate(async () => { const m = await import('/script.js'); await m.swipe(null, 'right'); });
    await waitFor(page, (i) => {
        const m = SillyTavern.getContext().chat[i];
        return m.swipes?.length >= 2 && m.mes.includes('新版本') && ['done', 'nochange'].includes(m.horae_meta?._bg?.status)
            && m.horae_meta._bg.swipeId === m.swipe_id;
    }, idx, 40000);
    snap = await chatSnapshot(page);
    rpg = await rpgData(page);
    check(results, 'S11 selected new swipe without damage: HP rolls back to 54', rpg?.bars?.[U]?.hp?.[0] === 54, `hp ${rpg?.bars?.[U]?.hp?.[0]}`);
    check(results, 'S11 old swipe prose untouched in swipes[]', snap[idx].swipes === 2 && (await page.evaluate((i) => SillyTavern.getContext().chat[i].swipes[0], idx)) === '巨石砸中了你，失去 20 点生命。');
    const auxCountBefore = (await mock('/logs')).filter(l => l.type === 'aux').length;
    await page.evaluate(async () => { const m = await import('/script.js'); await m.swipe(null, 'left'); });
    await page.waitForTimeout(1500);
    rpg = await rpgData(page);
    const auxCountAfter = (await mock('/logs')).filter(l => l.type === 'aux').length;
    check(results, 'S11 swiping back restores cached analysis without new request', rpg?.bars?.[U]?.hp?.[0] === 34 && auxCountAfter === auxCountBefore, `hp ${rpg?.bars?.[U]?.hp?.[0]}, aux ${auxCountBefore}->${auxCountAfter}`);
    await page.evaluate(async () => { const m = await import('/script.js'); await m.swipe(null, 'right'); });
    await page.waitForTimeout(1500);
    rpg = await rpgData(page);
    check(results, 'S11 swiping forward again restores no-damage version', rpg?.bars?.[U]?.hp?.[0] === 54, `hp ${rpg?.bars?.[U]?.hp?.[0]}`);

    // ===== 场景 12：编辑旧楼层 =====
    snap = await chatSnapshot(page);
    const hitIdx = snap.findIndex(m => m.mes === '你被重重击倒，失去 30 点生命。');
    const hpPre = (await rpgData(page))?.bars?.[U]?.hp?.[0];
    await page.evaluate(async ({ i }) => {
        const ctx = SillyTavern.getContext();
        ctx.chat[i].mes = '你被击倒在地，但很快爬了起来，没有受伤。';
        if (Array.isArray(ctx.chat[i].swipes)) ctx.chat[i].swipes[ctx.chat[i].swipe_id || 0] = ctx.chat[i].mes;
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, i);
    }, { i: hitIdx });
    await waitFor(page, (i) => {
        const m = SillyTavern.getContext().chat[i];
        return m.horae_meta?._bg?.status === 'nochange';
    }, hitIdx, 30000).catch(() => {});
    rpg = await rpgData(page);
    check(results, 'S12 editing an older message replaces its delta and rebuilds later state', rpg?.bars?.[U]?.hp?.[0] === hpPre + 30, `hp ${hpPre} -> ${rpg?.bars?.[U]?.hp?.[0]}`);
    snap = await chatSnapshot(page);
    check(results, 'S12 edited prose kept exactly as edited', snap[hitIdx].mes === '你被击倒在地，但很快爬了起来，没有受伤。');

    // ===== 场景 13：立即下一回合（等待后台分析，不死锁） =====
    await mock('/control', { mainQueue: ['地下室里一片漆黑，石阶尽头传来水滴声。', '你点亮了火柴。'], auxDelayMs: 3000, clearLogs: true });
    await sendUser(page, '我走下石阶。');
    idx = (await chatSnapshot(page)).length - 1;
    const t0 = Date.now();
    await sendUser(page, '我点亮火柴。');
    const waited = Date.now() - t0;
    logs = await mock('/logs');
    const mainReq = logs.filter(l => l.type === 'main')[1];
    check(results, 'S13 next turn waited for pending analysis and saw committed location', JSON.stringify(mainReq?.messages || []).includes('地下室'), `waited ${waited}ms`);
    await mock('/control', { auxDelayMs: 0 });
    await page.waitForTimeout(500);

    await waitIdle(page);

    // ===== 场景 16：HUD 直接编辑（真实 HUD 输入框 → change 事件 → commitRpgEdit） =====
    const hudIdx = (await chatSnapshot(page)).length - 1;
    const mesBeforeHud = (await chatSnapshot(page)).map(m => m.mes);
    const hudEdit = await page.evaluate(async ({ i, user }) => {
        const hud = document.querySelector(`.mes[mesid="${i}"] .horae-rpg-hud`);
        if (!hud) return { hasHud: false };
        const input = hud.querySelector(`.horae-rpg-hud-row[data-char="${user}"] .horae-rpg-hud-edit-input[data-edit-kind="bar-cur"][data-edit-key="hp"]`);
        if (!input) return { hasHud: true, hasInput: false, html: hud.innerHTML.slice(0, 300) };
        input.value = '70';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 800));
        return { hasHud: true, hasInput: true };
    }, { i: hudIdx, user: U });
    rpg = await rpgData(page);
    snap = await chatSnapshot(page);
    check(results, 'S16 HUD is shown on the latest message in metadata mode', hudEdit.hasHud && hudEdit.hasInput, JSON.stringify(hudEdit).slice(0, 200));
    check(results, 'S16 HUD edit updates state immediately', rpg?.bars?.[U]?.hp?.[0] === 70, JSON.stringify(rpg?.bars?.[U]));
    check(results, 'S16 HUD edit leaves every mes byte-identical', JSON.stringify(snap.map(m => m.mes)) === JSON.stringify(mesBeforeHud));
    check(results, 'S16 HUD edit stored as manual override in metadata', !!snap[hudIdx].meta?._manualRpgEdits?.bars?.[U]?.hp);

    // ===== 场景 17：向量记忆（重载前） =====
    const vecBefore = await page.evaluate(async (vmUrl) => {
        const mod = await import(vmUrl);
        const vm = mod.vectorManager;
        return { ready: vm.isReady, size: vm.vectors?.size || 0, docs: [...(vm.vectors?.values() || [])].map(v => v.document) };
    }, VM_URL);
    check(results, 'S17 vector index built from background metadata (no inline tags in mes)', vecBefore.ready && vecBefore.size > 0 && vecBefore.docs.some(d => d.includes('教会')), `size=${vecBefore.size} docs=${JSON.stringify(vecBefore.docs).slice(0, 200)}`);

    // ===== 场景 10：重新加载 =====
    const before = await chatSnapshot(page);
    const rpgBefore = await rpgData(page);
    const chatRef = await currentChatRef(page);
    await mock('/control', { clearLogs: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openST(page);
    await reopenChat(page, chatRef);
    await page.waitForTimeout(2000);
    const after = await chatSnapshot(page);
    const rpgAfter = await rpgData(page);
    logs = await mock('/logs');
    check(results, 'S10 reload: per-message metadata and markers persisted', JSON.stringify(after.map(m => [m.mes, m.bg?.status, m.bg?.fp])) === JSON.stringify(before.map(m => [m.mes, m.bg?.status, m.bg?.fp])));
    check(results, 'S10 reload: aggregate RPG state identical', JSON.stringify(rpgAfter?.bars) === JSON.stringify(rpgBefore?.bars), JSON.stringify(rpgAfter?.bars));
    check(results, 'S10 reload: rendering history triggers no analysis requests', logs.filter(l => l.type === 'aux').length === 0, `aux requests: ${logs.filter(l => l.type === 'aux').length}`);
    check(results, 'S1 reload: no tags in any mes', after.every(m => noTags(m.mes)));

    const vecAfter = await page.evaluate(async (vmUrl) => {
        const mod = await import(vmUrl);
        return { size: mod.vectorManager.vectors?.size || 0 };
    }, VM_URL);
    check(results, 'S17 vector index persisted across reload', vecAfter.size === vecBefore.size, `${vecBefore.size} -> ${vecAfter.size}`);
    check(results, 'S16 HUD edit survives reload/rebuild', rpgAfter?.bars?.[U]?.hp?.[0] === 70);
    await mock('/control', { mainQueue: ['你检查了自己的伤势。'], clearLogs: true });
    await sendUser(page, '我检查伤势。');
    logs = await mock('/logs');
    check(results, 'S16 manual HUD value visible to the GM next turn', /70\s*\/\s*100/.test(JSON.stringify(logs.find(l => l.type === 'main')?.messages || [])));
    await waitIdle(page);

    // ===== 场景 14：切换聊天时的迟到结果 =====
    await mock('/control', { mainQueue: ['你在教会里发现了一张地图。'], auxDelayMs: 4000, auxRules: [...AUX_RULES(U), { match: '发现了一张地图', response: `<horae>\nitem:🗺️地图=${U}@手中\nlocation:来自聊天A的地点\n</horae>` }], clearLogs: true });
    await sendUser(page, '我四处查看。');
    const chatARef = await currentChatRef(page);
    const chatAIdx = (await chatSnapshot(page)).length - 1;
    await page.waitForTimeout(500);
    await newChatWithFirstCharacter();
    const chatBId = await page.evaluate(() => SillyTavern.getContext().getCurrentChatId());
    await page.waitForTimeout(6000);
    snap = await chatSnapshot(page);
    check(results, 'S14 late result from chat A never written into chat B', chatARef.chatId !== chatBId && snap.every(m => !JSON.stringify(m.meta || {}).includes('来自聊天A')), `A=${chatARef.chatId} B=${chatBId}`);
    // 回到聊天 A：被中断的分析自动续上（仅末尾、仅无状态楼层）
    await mock('/control', { auxDelayMs: 0, clearLogs: true });
    await reopenChat(page, chatARef);
    await waitBg(page, chatAIdx, ['done', 'nochange'], 30000).catch(() => {});
    snap = await chatSnapshot(page);
    logs = await mock('/logs');
    check(results, 'S14 interrupted analysis resumes once when returning to chat A', snap[chatAIdx]?.bg?.status === 'done' && logs.filter(l => l.type === 'aux').length === 1, `status=${snap[chatAIdx]?.bg?.status} aux=${logs.filter(l => l.type === 'aux').length}`);

    // ===== 场景 19：无关功能保持（自动总结未被强制开启；面板可用） =====
    const misc = await page.evaluate(() => {
        const s = SillyTavern.getContext().extensionSettings.horae;
        return {
            autoSummaryEnabled: s.autoSummaryEnabled,
            tabs: document.querySelectorAll('#horae-drawer .horae-tab, #horae_drawer .horae-tab, .horae-tabs .horae-tab').length,
            regexRules: (SillyTavern.getContext().extensionSettings.regex || []).filter(r => String(r.id || '').startsWith('horae_')).length,
        };
    });
    check(results, 'S19 auto-summary not forced on; Horae tabs and legacy regex rules still installed', misc.autoSummaryEnabled === false && misc.tabs > 0 && misc.regexRules === 5, JSON.stringify(misc));

    // ===== 场景 15：群聊（GM + 独立角色卡，共享世界状态，不重复结算 USER 行动） =====
    const groupId = await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        const resp = await fetch('/api/groups/create', {
            method: 'POST', headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ name: 'Horae E2E Group', members: ['default_Seraphina.png', 'default_Assistant.png'], activation_strategy: 1, generation_mode: 0 }),
        });
        return (await resp.json()).id;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openST(page);
    await page.evaluate(async (id) => { const gm = await import('/scripts/group-chats.js'); await gm.openGroupById(id); }, groupId);
    await page.waitForTimeout(4000);
    await waitIdle(page);
    await mock('/control', { mainQueue: ['群聊-GM：酒馆里一片欢腾，有人递给你一杯麦酒。', '群聊-Assistant：她笑着向你举杯致意。'], clearLogs: true });
    const gBefore = (await chatSnapshot(page)).length;
    await page.fill('#send_textarea', '我向两人举杯。');
    await page.click('#send_but');
    await waitFor(page, (n) => SillyTavern.getContext().chat.length >= n + 3, gBefore, 60000);
    await page.waitForTimeout(1500);
    await waitIdle(page);
    snap = await chatSnapshot(page);
    logs = await mock('/logs');
    const gAux = logs.filter(l => l.type === 'aux');
    const secondAux = gAux.find(a => a.story.includes('群聊-Assistant'));
    const firstAux = gAux.find(a => a.story.includes('群聊-GM'));
    check(results, 'S15 both group replies analyzed into one shared state', snap.slice(-2).every(m => ['done', 'nochange'].includes(m.bg?.status)), JSON.stringify(snap.slice(-2).map(m => [m.name, m.bg?.status])));
    check(results, 'S15 first reply settles the USER action; second reply sees it as already settled', firstAux && !/ALREADY SETTLED|已结算/.test(JSON.stringify(firstAux.messages)) && secondAux && /ALREADY SETTLED|已结算/.test(JSON.stringify(secondAux.messages)));
    check(results, 'S15/S20 analysis never adds messages to the group chat', snap.length === gBefore + 3, `before ${gBefore}, after ${snap.length}`);
    const gItems = snap.flatMap(m => Object.keys(m.meta?.items || {}));
    check(results, 'S15 shared world state updated once (no duplicate item)', gItems.filter(n => n === '麦酒').length === 1, JSON.stringify(gItems));

    // ===== 场景 9b：辅助 API 缺少密钥且不允许回退 → 明确失败；关闭辅助 API → 按用户设置走主 API（generateRaw） =====
    await newChatWithFirstCharacter();
    await waitIdle(page);
    await page.evaluate(() => { document.getElementById('horae-setting-aux-api-key').value = ''; });
    await mock('/control', { mainQueue: ['你捡起了一枚银色徽章，上面刻着十字。'], clearLogs: true });
    await sendUser(page, '我捡起徽章。');
    idx = (await chatSnapshot(page)).length - 1;
    await waitBg(page, idx, ['failed']);
    snap = await chatSnapshot(page);
    logs = await mock('/logs');
    check(results, 'S9b missing aux key (no fallback) fails visibly without any request or state change', snap[idx].bg.status === 'failed' && logs.filter(l => l.type === 'aux').length === 0 && Object.keys(snap[idx].meta.items || {}).length === 0, snap[idx].bg.error);
    await page.evaluate(() => {
        document.getElementById('horae-setting-aux-api-key').value = 'test-key';
        const cb = document.getElementById('horae-setting-aux-api-enabled');
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await mock('/control', { clearLogs: true });
    const lenBeforeMain = (await chatSnapshot(page)).length;
    await page.evaluate((i) => window.Horae.background.reanalyze(i), idx);
    await waitBg(page, idx, ['done', 'nochange', 'failed'], 30000);
    snap = await chatSnapshot(page);
    logs = await mock('/logs');
    check(results, 'S9b aux disabled: analysis routed through main API without adding chat messages', snap[idx].bg.status === 'done' && snap.length === lenBeforeMain && logs.some(l => l.type === 'aux' && l.model === 'mock-main'), `status=${snap[idx].bg.status} len ${lenBeforeMain}->${snap.length} models=${JSON.stringify(logs.filter(l => l.type === 'aux').map(l => l.model))}`);
    const snapCount = (l) => (JSON.stringify(l.messages).match(/Current State Snapshot|当前状态快照/g) || []).length;
    check(results, 'S9b main-API analysis was not given a second Horae context injection', logs.filter(l => l.type === 'aux').every(l => snapCount(l) === 1), JSON.stringify(logs.filter(l => l.type === 'aux').map(snapCount)));
    await page.evaluate(() => {
        const cb = document.getElementById('horae-setting-aux-api-enabled');
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(500);

    // ===== 场景 18：切换到旧版模式（内联标签）仍然可用 =====
    await page.evaluate((v) => window.jQuery('#horae-setting-state-mode').val(v).trigger('change'), 'legacy');
    await page.waitForTimeout(500);
    await newChatWithFirstCharacter();
    await mock('/control', { mainQueue: ['旧版模式剧情。\n<horae>\ntime:2004/2/2 08:00\nlocation:卫宫宅\ncharacters:' + U + '\n</horae>\n<horaeevent>\nevent:一般|旧版模式测试\n</horaeevent>'], clearLogs: true });
    await sendUser(page, '早上好。');
    await page.waitForTimeout(1500);
    snap = await chatSnapshot(page);
    logs = await mock('/logs');
    const legacyMain = JSON.stringify(logs.find(l => l.type === 'main')?.messages || []);
    const last = snap[snap.length - 1];
    const shown = await page.evaluate((i) => document.querySelector(`.mes[mesid="${i}"] .mes_text`)?.innerText || '', last.i);
    check(results, 'S18 legacy: main prompt still instructs <horae> output', /<horae>/.test(legacyMain));
    check(results, 'S18 legacy: inline tags parsed into metadata', last.meta?.scene?.location === '卫宫宅' && last.meta?.events?.length === 1, JSON.stringify(last.meta?.scene));
    check(results, 'S18 legacy: tags hidden from display by regex', !/location:|<horae>/.test(shown), shown.slice(0, 120));
    check(results, 'S18 legacy: no background analysis requests', logs.filter(l => l.type === 'aux').length === 0);
    await page.evaluate((v) => window.jQuery('#horae-setting-state-mode').val(v).trigger('change'), 'metadata');
    await page.waitForTimeout(500);
    await page.waitForTimeout(2500); // 等 ST 防抖保存落盘
    const modeBack = await page.evaluate(() => SillyTavern.getContext().extensionSettings.horae.stateMode);
    check(results, 'P0-A mode switch persists and does not erase data', modeBack === 'metadata' && last.meta?.scene?.location === '卫宫宅');

    writeFileSync(new URL('./last-results.json', import.meta.url), JSON.stringify({ results }, null, 2));
} catch (err) {
    console.error('E2E crashed:', err);
    results.push({ name: 'harness', pass: false, detail: String(err?.stack || err) });
} finally {
    const errs = consoleLines.filter(l => /pageerror|\[error\].*Horae|Horae.*(失败|failed)/i.test(l));
    writeFileSync(new URL('./last-console.log', import.meta.url), consoleLines.join('\n'));
    console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks passed`);
    if (errs.length) console.log('Relevant console errors:\n' + errs.slice(0, 30).join('\n'));
    await browser.close();
}
