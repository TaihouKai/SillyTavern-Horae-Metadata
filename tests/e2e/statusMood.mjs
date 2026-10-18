// 临时状态（RPG status: 流血 / mood: 兴奋）能否从后台分析一路写到状态与 UI
import { writeFileSync } from 'node:fs';
import { launch, openST, mock, sendUser, waitIdle, sleep } from './lib.mjs';
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const { browser, page, consoleLines } = await launch();
const OUT = process.argv[2] || ''; // 传入路径时把提示词写到文件，便于人工审阅

const lastAux = async () => { const l = (await mock('/logs')).filter(x => x.type === 'aux'); return l[l.length - 1]; };
const state = () => page.evaluate(() => {
    const latest = window.Horae.getLatestState() || {};
    const rpg = window.Horae.getRpgState() || {};
    const c = SillyTavern.getContext().chat; const last = c[c.length - 1];
    return { mood: latest.mood || null, rpgStatus: rpg?.status || null, lastMeta: { mood: last.horae_meta?.mood, rpg: last.horae_meta?._rpgChanges?.status, bg: last.horae_meta?._bg?.status } };
});

try {
    await mock('/reset', {});
    await openST(page);
    await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        let id = ctx.characters.findIndex(c => c.name === 'Seraphina'); if (id < 0) id = 0;
        if (String(ctx.characterId) !== String(id)) await ctx.selectCharacterById(id);
        Object.assign(ctx.extensionSettings.horae, { sendMood: true, rpgMode: true, sendRpgBars: true, rpgBarsUserOnly: false });
    });
    await sleep(1500);
    await page.evaluate(async () => { const m = await import('/script.js'); await m.doNewChat({ deleteCurrentChat: false }); });
    await sleep(2500);
    const userName = await page.evaluate(() => SillyTavern.getContext().name1);

    for (const mode of ['tag', 'json']) {
        const reply = mode === 'tag'
            ? `<horae>\ntime:2020/09/18 20:00\nlocation:森林\ncharacters:Seraphina,${userName}\nmood:Seraphina=兴奋\n</horae>\n<horaerpg>\nstatus:${userName}=流血/虚弱\n</horaerpg>`
            : JSON.stringify({ notes: null, horae: `time:2020/09/18 20:00\nlocation:森林\ncharacters:Seraphina,${userName}\nmood:Seraphina=兴奋`, event: '', rpg: `status:${userName}=流血/虚弱`, tables: [] });
        const key = mode === 'tag' ? '狼咬伤了你' : '又一只狼咬伤了你';
        await mock('/control', { auxRules: [{ match: key, response: reply }], mainQueue: [`${key}，鲜血直流。Seraphina 兴奋地拔出了剑。`], clearLogs: true });
        await sendUser(page, '我们继续前进。');
        await waitIdle(page, 30000);
        const aux = await lastAux();
        const prompt = (aux?.messages || []).map(m => m.content).join('\n');
        if (mode === 'tag' && OUT) writeFileSync(OUT, (aux?.messages || []).map(m => `===== ${m.role} =====\n${m.content}`).join('\n\n'));
        check(`[${mode}] analysis prompt asks for mood:`, /^mood:/m.test(prompt));
        check(`[${mode}] analysis prompt asks for RPG status:`, /status:/.test(prompt));
        const s = await state();
        check(`[${mode}] mood stored`, s.lastMeta.mood?.Seraphina === '兴奋' && s.mood?.Seraphina === '兴奋', JSON.stringify(s.lastMeta));
        const st = s.lastMeta.rpg?.[userName];
        check(`[${mode}] RPG status stored on the message`, Array.isArray(st) && st.includes('流血') && st.includes('虚弱'), JSON.stringify(s.lastMeta.rpg));
        check(`[${mode}] RPG status in current RPG state`, (s.rpgStatus?.[userName] || []).includes('流血'), JSON.stringify(s.rpgStatus));
        // 清除，让 json 轮次从空开始
        if (mode === 'tag') {
            await page.evaluate(() => { const c = SillyTavern.getContext().chat; const m = c[c.length - 1]; delete m.horae_meta.mood; if (m.horae_meta._rpgChanges) m.horae_meta._rpgChanges.status = {}; });
        }
    }
    const aggregate = await page.evaluate((u) => {
        const H = window.Horae?.manager; H?.rebuildRpgData?.();
        return SillyTavern.getContext().chat[0]?.horae_meta?.rpg?.status?.[u] || null;
    }, userName);
    check('RPG status reaches the chat-wide aggregate', Array.isArray(aggregate) && aggregate.includes('流血'), JSON.stringify(aggregate));
    // 下一回合：主模型收到的 Horae 上下文里应包含情绪与状态
    await mock('/control', { mainQueue: ['你们包扎了伤口。'], clearLogs: true });
    await sendUser(page, '先包扎。');
    await waitIdle(page, 30000);
    const main = (await mock('/logs')).find(l => l.type === 'main');
    const mainText = (main?.messages || []).map(m => m.content).join('\n');
    check('next turn: main model context includes the mood (兴奋)', mainText.includes('兴奋'));
    check('next turn: main model context includes the status (流血)', mainText.includes('流血'));
    if (OUT) writeFileSync(OUT.replace('.txt','-main.txt'), mainText);
    const html = await page.evaluate(() => document.body.innerHTML);
    check('流血 rendered in the page (RPG HUD / panel)', html.includes('流血'));
    const errs = consoleLines.filter(l => /^\[(error|pageerror)\]/.test(l) && /horae/i.test(l) && !/TavernHelper/.test(l));
    check('no Horae errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { console.log('ERR', e.message.split('\n')[0]); results.push(false); }
finally {
    await page.evaluate(() => Object.assign(SillyTavern.getContext().extensionSettings.horae, { sendMood: false })).catch(() => {});
    await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
