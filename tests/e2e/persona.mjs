/**
 * Persona 开局状态：真实 SillyTavern 中的生命周期、实际发送内容、HUD 与持久化。
 * 前置条件同 run.mjs（ST 主 API 指向 mock；mockServer 运行中）。
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launch, openST, mock, sendUser, check, waitIdle, currentChatRef, reopenChat } from './lib.mjs';

const KEY_DESC = '刻着 A|B=C@3F 的黄铜钥匙。\n第二行：备用钥匙在公寓管理员处。';
const SKILL1_DESC = '能感知半径五米内的电磁场变化。\n限制：雨天精度下降一半；无法感知绝缘体后方的物体。';
const FIXTURE = {
    horaePersonaProfile: 1,
    schema: 1,
    bars: [
        { key: 'hp', name: '生命', current: 100, max: 100, color: '#ef4444', desc: '' },
        { key: 'mp', name: '魔力', current: 60, max: 60, color: '#3b82f6', desc: '' },
        { key: 'sp', name: '体力', current: 80, max: 80, color: '#22c55e', desc: '' },
    ],
    skills: [
        { name: '电磁感知', level: 'Lv3', desc: SKILL1_DESC },
        { name: '冷静分析', level: '', desc: '在危机中强制保持冷静。限制：每天只能主动使用一次，使用后会剧烈头痛。' },
    ],
    items: [
        { name: '旧公寓钥匙', icon: '🔑', quantity: 1, description: KEY_DESC },
        { name: '灰色风衣', icon: '🧥', quantity: 1, description: '防水风衣，内袋可放证件。', location: '身上' },
        { name: '急救喷雾', icon: '🧴', quantity: 2, unit: '瓶', description: '一次性止血喷雾。限制：每瓶只能用一次。' },
    ],
    strongholds: [
        { id: 'base1', name: '第七学区安全屋', level: 1, desc: '老旧公寓顶层。' },
        { id: 'room1', name: '地下工作室', parent: 'base1', desc: '安全屋地下的改装工作间。' },
    ],
};

const results = [];
const { browser, page, consoleLines } = await launch();

const status = () => page.evaluate(() => window.Horae.persona.getStatus());
const record = () => page.evaluate(() => window.Horae.persona.getRecord());
const newChat = async () => {
    await page.evaluate(async () => (await import('/script.js')).doNewChat({ deleteCurrentChat: false }));
    await page.waitForTimeout(2500);
};
const lastAi = () => page.evaluate(() => {
    const chat = SillyTavern.getContext().chat;
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user) return i;
    return -1;
});
const hudText = (idx) => page.evaluate((i) => document.querySelector(`.mes[mesid="${i}"] .horae-rpg-hud`)?.innerText || '', idx);
const setRpgMode = async (on) => {
    await page.evaluate((v) => {
        const el = document.getElementById('horae-setting-rpg-mode');
        el.checked = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, on);
    await page.waitForTimeout(300);
};const setProfileEnabled = async (on) => {
    await page.evaluate(() => window.Horae.persona.openEditor());
    await page.waitForSelector('#horae-pp-enabled');
    if (on) await page.check('#horae-pp-enabled'); else await page.uncheck('#horae-pp-enabled');
    await page.click('#horae-pp-save');
    await page.waitForTimeout(400);
    await page.click('#horae-pp-close');
};const snapshotItems = () => page.evaluate(() => JSON.stringify(SillyTavern.getContext().chat.map(m => m.mes)));

try {
    await mock('/reset', {});
    await openST(page);
    const U = await page.evaluate(() => SillyTavern.getContext().name1);
    const personaKey = await page.evaluate(async () => (await import('/scripts/personas.js')).user_avatar);
    console.log(`player=${U} persona=${personaKey}`);
    await page.evaluate(() => {
        const s = SillyTavern.getContext().extensionSettings.horae;
        Object.assign(s, { rpgMode: true, sendRpgBars: true, sendRpgSkills: true, sendRpgStronghold: true, sendItems: true, injectContext: true, auxApiEnabled: true });
        window.jQuery('#horae-setting-state-mode').val('metadata').trigger('change');
    });
    await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId === undefined || ctx.groupId) await ctx.selectCharacterById(0);
    });
    await page.waitForTimeout(1500);

    // ---- 编辑器：经 JSON 导入填写参考模板，启用并保存 ----
    const dir = mkdtempSync(path.join(tmpdir(), 'horae-pp-'));
    const file = path.join(dir, 'fixture.json');
    writeFileSync(file, JSON.stringify(FIXTURE));
    await page.evaluate(() => window.Horae.persona.openEditor());
    await page.waitForSelector('#horae-persona-modal #horae-pp-body .horae-pp-persona');
    await page.setInputFiles('#horae-pp-import-file', file);
    await page.waitForTimeout(500);
    await page.check('#horae-pp-enabled');
    // 前置开关：编辑器提供一键开启（只开启本模板需要的现有开关）
    if (await page.$('#horae-pp-enable-prereq')) {
        await page.click('#horae-pp-enable-prereq');
        await page.waitForTimeout(500);
        await page.check('#horae-pp-enabled');
    }
    const prereqOk = await page.evaluate(() => [...document.querySelectorAll('.horae-pp-prereq span')].every(s => s.classList.contains('ok')));
    check(results, 'editor: "enable required switches" turns on every prerequisite', prereqOk);
    await page.click('#horae-pp-save');
    await page.waitForTimeout(500);
    const saved = await page.evaluate(() => window.Horae.persona.getProfile());
    check(results, 'editor: JSON import + save stores a validated, enabled profile keyed by the native Persona',
        saved?.enabled && saved.personaKey === personaKey && saved.skills[0].desc === SKILL1_DESC && saved.items[0].description === KEY_DESC && saved.revision >= 1,
        JSON.stringify({ enabled: saved?.enabled, key: saved?.personaKey, rev: saved?.revision }));
    const resultText = await page.evaluate(() => document.getElementById('horae-pp-result')?.innerText || '');
    check(results, 'editor: structured preview shown after save', /急救喷雾\(2瓶\)/.test(resultText) && /生命\(hp\) 100\/100/.test(resultText), resultText.slice(0, 160));
    await page.click('#horae-pp-close');

    // ---- 新聊天：第一次剧情请求前完成初始化 ----
    await newChat();
    const st0 = await status();
    check(results, 'fresh chat shows "ready" before sending', st0.state === 'ready', JSON.stringify(st0));
    await mock('/control', { clearLogs: true, mainQueue: ['雨夜。你站在第七学区的街口，霓虹灯在积水里晃动。'], auxRules: [] });
    await sendUser(page, '开始');
    await waitIdle(page);
    let logs = await mock('/logs');
    const rec = await record();
    const mainReqs = logs.filter(l => l.type === 'main');
    const firstMain = mainReqs[0];
    const firstMainText = (firstMain?.messages || []).map(m => m.content).join('\n');
    check(results, 'baseline committed (status applied, owner = active player)', rec?.status === 'applied' && rec.owner === U && rec.personaKey === personaKey, JSON.stringify({ status: rec?.status, owner: rec?.owner }));
    check(results, 'baseline committed before the first main-model request', rec && firstMain && Date.parse(rec.at) <= firstMain.at, `${rec?.at} vs ${firstMain && new Date(firstMain.at).toISOString()}`);
    check(results, 'bootstrap itself made no LLM request (no analyzer call before the story request)', logs.filter(l => l.type === 'aux' && l.at < firstMain.at).length === 0);
    check(results, 'first request snapshot contains bars, skills, items and strongholds',
        /生命 100\/100/.test(firstMainText) && /魔力 60\/60/.test(firstMainText) && /电磁感知 Lv3/.test(firstMainText)
        && /旧公寓钥匙/.test(firstMainText) && /急救喷雾\(2瓶\)/.test(firstMainText) && /地下工作室/.test(firstMainText), firstMainText.slice(-400));
    check(results, 'first request has no tag-output instruction for the GM', !/<horae>|<horaerpg>|horaeevent/.test(firstMainText));
    const ai1 = await lastAi();
    await page.waitForTimeout(800);
    let hud = await hudText(ai1);
    check(results, 'HUD shows the player sheet although the reply established no cast', hud.includes('生命') && hud.includes('100') && hud.includes('魔力'), hud.slice(0, 120));
    check(results, 'separate RPG equipment store not populated', await page.evaluate(() => Object.keys(SillyTavern.getContext().chat[0]?.horae_meta?.rpg?.equipment || {}).length === 0));
    const commitId = rec.commitId;

    // ---- 下一回合：HP 88 / MP 45；重新加载后保持 ----
    await mock('/control', { clearLogs: true, mainQueue: ['一道电光擦过你的肩膀，你咬牙用感知锁定了对方。'],
        auxRules: [{ match: '一道电光擦过', response: `<horaerpg>\nhp:${U}=88/100\nmp:${U}=45/60\n</horaerpg>` }] });
    await sendUser(page, '躲开');
    await waitIdle(page);
    const mesBefore = await snapshotItems();
    const ref = await currentChatRef(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openST(page);
    await reopenChat(page, ref);
    await page.waitForTimeout(1500);
    const rec2 = await record();
    const rpgAfter = await page.evaluate(() => {
        const ctx = SillyTavern.getContext();
        return ctx.chat[0]?.horae_meta?.rpg?.bars;
    });
    const ai2 = await lastAi();
    hud = await hudText(ai2);
    check(results, 'reload: same baseline record (no second initialization)', rec2?.commitId === commitId);
    check(results, 'reload: HP 88 / MP 45 kept, not reset to starting values', JSON.stringify(rpgAfter?.[U]?.hp?.slice(0, 2)) === '[88,100]' && JSON.stringify(rpgAfter?.[U]?.mp?.slice(0, 2)) === '[45,60]', JSON.stringify(rpgAfter?.[U]));
    check(results, 'reload: HUD shows current values', hud.includes('88') && hud.includes('45'), hud.slice(0, 120));
    check(results, 'all message texts byte-identical after reload', (await snapshotItems()) === mesBefore);

    // ---- 分支：继承基线与历史，不会再次初始化 ----
    {
        const mainRef = await currentChatRef(page);
        const branchName = await page.evaluate(async () => {
            const ctx = SillyTavern.getContext();
            return (await import('/scripts/bookmarks.js')).createBranch(ctx.chat.length - 1);
        });
        await page.evaluate(async (name) => SillyTavern.getContext().openCharacterChat(name), branchName);
        await page.waitForFunction((n) => SillyTavern.getContext().getCurrentChatId() === n, branchName, { timeout: 30000 });
        await page.waitForTimeout(1500);
        const brRec = await record();
        await mock('/control', { clearLogs: true, mainQueue: ['分支剧情。'], auxRules: [] });
        await sendUser(page, '分支继续');
        await waitIdle(page);
        const brPrompt = ((await mock('/logs')).find(l => l.type === 'main')?.messages || []).map(m => m.content).join('\n');
        check(results, 'branch: inherits the same baseline record and current state; no second seed',
            brRec?.commitId === commitId && (await record())?.commitId === commitId && /生命 88\/100/.test(brPrompt) && (brPrompt.match(/旧公寓钥匙/g) || []).length === 1,
            JSON.stringify({ branch: branchName, rec: brRec?.commitId === commitId }));
        await reopenChat(page, mainRef);
    }

    // ---- regenerate 最后一条回复：基线不变 ----
    await mock('/control', { clearLogs: true, mainQueue: ['（重写）电光被你侧身躲过。'], auxRules: [{ match: '（重写）', response: '<horaenochange/>' }] });
    await page.evaluate(async () => { await (await import('/script.js')).Generate('regenerate'); });
    await page.waitForTimeout(1500);
    await waitIdle(page);
    const rec3 = await record();
    check(results, 'regenerate: same baseline record reused', rec3?.commitId === commitId);
    const prompt3 = (await mock('/logs')).find(l => l.type === 'main');
    const p3 = (prompt3?.messages || []).map(m => m.content).join('\n');
    check(results, 'regenerate request: one copy of each starting item', (p3.match(/旧公寓钥匙/g) || []).length === 1 && (p3.match(/急救喷雾/g) || []).length === 1, `${(p3.match(/旧公寓钥匙/g) || []).length}`);

    // ---- 显式清空：下次发送不自动恢复 ----
    await page.evaluate(() => document.getElementById('horae-btn-clear')?.click());
    await page.waitForTimeout(1500);
    const stCleared = await status();
    await mock('/control', { clearLogs: true, mainQueue: ['空白的一夜。'] });
    await sendUser(page, '继续');
    await waitIdle(page);
    logs = await mock('/logs');
    const pc = (logs.find(l => l.type === 'main')?.messages || []).map(m => m.content).join('\n');
    check(results, 'clear-all: baseline cleared and not restored on the next send', stCleared.state === 'cleared' && (await record())?.status === 'cleared' && !/旧公寓钥匙/.test(pc), stCleared.state);

    // ---- 前置开关缺失：可见失败、取消生成、不写入；修复后重试成功 ----
    await newChat();
    await setRpgMode(false);
    await mock('/control', { clearLogs: true, mainQueue: ['不应出现的剧情。'] });
    const lenBefore = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await page.fill('#send_textarea', '开始');
    await page.click('#send_but');
    await page.waitForTimeout(4000);
    logs = await mock('/logs');
    const stFail = await status();
    const lenAfter = await page.evaluate(() => SillyTavern.getContext().chat.length);
    const aiAdded = await page.evaluate((n) => SillyTavern.getContext().chat.slice(n).some(m => !m.is_user), lenBefore);
    check(results, 'missing prerequisite: no request sent, no reply, no record, visible failure',
        logs.filter(l => l.type === 'main').length === 0 && !aiAdded && !(await record()) && (stFail.state === 'failed' || stFail.state === 'prereqMissing'),
        JSON.stringify({ main: logs.filter(l => l.type === 'main').length, len: `${lenBefore}->${lenAfter}`, st: stFail }));
    await setRpgMode(true);
    await mock('/control', { clearLogs: true, mainQueue: ['第一幕终于开始。'] });
    await page.evaluate(async () => { await (await import('/script.js')).Generate('normal'); });
    await page.waitForTimeout(2000);
    await waitIdle(page);
    logs = await mock('/logs');
    const retry = (logs.find(l => l.type === 'main')?.messages || []).map(m => m.content).join('\n');
    check(results, 'retry after enabling the switch initializes and sends the full baseline', (await record())?.status === 'applied' && /生命 100\/100/.test(retry), (await status()).state);

    // ---- 关闭模板：新聊天不初始化 ----
    await setProfileEnabled(false);

    await newChat();
    await mock('/control', { clearLogs: true, mainQueue: ['平凡的一天。'] });
    await sendUser(page, '开始');
    await waitIdle(page);
    check(results, 'disabled profile: no automatic seed', !(await record()));

    // ---- 旧对话：不自动初始化 ----
    await setProfileEnabled(true);

    await mock('/control', { clearLogs: true, mainQueue: ['旧对话继续。'] });
    await sendUser(page, '继续');
    await waitIdle(page);
    const stOld = await status();
    check(results, 'old transcript without a marker is not seeded; status says not eligible', !(await record()) && stOld.state === 'notEligible', stOld.state);

    // ---- 补录：预览 + 选择 + 当前边界 ----
    await page.evaluate(() => document.querySelector('.horae-persona-btn-repair')?.click());
    await page.waitForSelector('#horae-persona-modal .horae-pp-repair-list');
    const rowsInfo = await page.evaluate(() => [...document.querySelectorAll('.horae-pp-repair-row')].map(r => r.dataset.status));
    await page.evaluate(() => {
        for (const cb of document.querySelectorAll('.horae-pp-repair-list input')) {
            if (!cb.disabled && /item:旧公寓钥匙|bar:hp/.test(cb.value)) cb.checked = true;
        }
    });
    await page.click('#horae-pp-repair-apply');
    await page.waitForTimeout(800);
    const recRepair = await record();
    const repaired = await page.evaluate(() => {
        const ctx = SillyTavern.getContext();
        return { bars: ctx.chat[0]?.horae_meta?.rpg?.bars, n: ctx.chat.length };
    });
    check(results, 'repair: preview lists every entry as missing, selected ones added at the current boundary',
        rowsInfo.length === 10 && recRepair?.status === 'repaired' && recRepair.repairs?.[0]?.afterIndex === repaired.n - 1
        && recRepair.repairs[0].items.length === 1 && recRepair.repairs[0].bars.length === 1, JSON.stringify({ rowsInfo, status: recRepair?.status }));

    // ---- carryover：继承边界状态 + 携带楼层增量，不重复重放、不再套用模板 ----
    await newChat();
    await mock('/control', { clearLogs: true, mainQueue: ['第一幕：你被流弹擦伤。', '第二幕：你用掉一瓶喷雾止血。'],
        auxRules: [
            { match: '第一幕：你被流弹擦伤', response: `<horaerpg>\nhp:${U}=88/100\n</horaerpg>` },
            { match: '第二幕：你用掉一瓶喷雾', response: `<horae>\nitem:🧴急救喷雾(1瓶)=${U}\n</horae>` },
        ] });
    await sendUser(page, '开始');
    await waitIdle(page);
    await sendUser(page, '止血');
    await waitIdle(page);
    const srcRec = await record();
    const srcChatId = await page.evaluate(() => SillyTavern.getContext().getCurrentChatId());
    await page.evaluate(() => document.getElementById('horae-btn-carry-new-chat')?.click());
    await page.waitForFunction((id) => SillyTavern.getContext().getCurrentChatId() !== id, srcChatId, { timeout: 30000 });
    await page.waitForTimeout(3000);
    const carriedRec = await record();
    await mock('/control', { clearLogs: true, mainQueue: ['新对话的第一幕。'], auxRules: [] });
    await sendUser(page, '继续');
    await waitIdle(page);
    logs = await mock('/logs');
    const cp = (logs.find(l => l.type === 'main')?.messages || []).map(m => m.content).join('\n');
    check(results, 'carryover: target marked inherited from the source owner (not re-seeded from the template)',
        srcRec?.status === 'applied' && carriedRec?.status === 'inherited' && carriedRec.owner === U && (await record())?.status === 'inherited',
        JSON.stringify({ src: srcRec?.status, dst: carriedRec?.status }));
    check(results, 'carryover: effective state preserved (HP 88, one spray left, one key, skills)',
        /生命 88\/100/.test(cp) && /急救喷雾\(1瓶\)/.test(cp) && !/急救喷雾\(2瓶\)/.test(cp) && (cp.match(/旧公寓钥匙/g) || []).length === 1 && /电磁感知/.test(cp),
        cp.slice(-300));

    // 清理：关闭模板，避免影响共用同一 ST 测试实例的其他 E2E 脚本
    await setProfileEnabled(false);
    await page.waitForTimeout(2500);

    // 「Generation was aborted.」是 ST 取消生成时自身抛出的（预检失败时的预期路径）
    const errs = consoleLines.filter(l => /\[pageerror\]|\[Horae\]\[Persona\].*(失败|异常)/.test(l) && !/TavernHelper|Generation was aborted/.test(l));
    check(results, 'no page errors from the persona feature', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
    console.error('crashed:', e);
    results.push({ pass: false });
} finally {
    await browser.close();
}
const ok = results.filter(r => r.pass).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
