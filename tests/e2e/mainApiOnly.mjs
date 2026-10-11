/**
 * Metadata 模式 + 不配置辅助 API：后台分析应经主 API（generateRaw）完成，
 * 不新增聊天楼层、不写入正文。前置条件同 run.mjs（ST 已配置主 API 指向 mock）。
 */
import { launch, openST, mock, sendUser, check, waitIdle, chatSnapshot } from './lib.mjs';

const results = [];
const { browser, page } = await launch();
try {
    await mock('/reset', {});
    await openST(page);
    const U = await page.evaluate(() => SillyTavern.getContext().name1);
    await page.evaluate(() => {
        const s = SillyTavern.getContext().extensionSettings.horae;
        Object.assign(s, { auxApiEnabled: false, useMainPresetForAiTasks: true });
        const el = document.getElementById('horae-setting-aux-api-enabled');
        if (el) el.checked = false;
        window.jQuery('#horae-setting-state-mode').val('metadata').trigger('change');
    });
    await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId === undefined || ctx.groupId) await ctx.selectCharacterById(0);
    });
    await page.waitForTimeout(1500);
    await page.evaluate(async () => (await import('/script.js')).doNewChat({ deleteCurrentChat: false }));
    await page.waitForTimeout(2500);

    await mock('/control', {
        clearLogs: true,
        mainQueue: ['你捡起了一枚银色徽章，上面刻着十字。'],
        auxRules: [{ match: '你捡起了一枚银色徽章', response: `<horae>\nitem!:🏅银色徽章|刻有十字的银色徽章=${U}@手中\n</horae>` }],
    });
    const lenBefore = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await sendUser(page, '我弯腰捡东西');
    await waitIdle(page);
    await page.waitForTimeout(500);

    const logs = await mock('/logs');
    const analyses = logs.filter(l => l.type === 'aux');
    const snap = await chatSnapshot(page);
    const last = snap[snap.length - 1];
    const items = await page.evaluate(() => JSON.stringify(SillyTavern.getContext().chat.map(m => m.horae_meta?.items || {})));

    check(results, 'analysis request sent through main API (model mock-main)', analyses.length === 1 && analyses[0].model === 'mock-main', JSON.stringify(analyses.map(a => a.model)));
    check(results, 'reply marked analyzed', last.bg?.status === 'done', JSON.stringify(last.bg));
    check(results, 'item extracted into metadata', items.includes('银色徽章'));
    check(results, 'no extra chat messages added', snap.length === lenBefore + 2, `${lenBefore} -> ${snap.length}`);
    check(results, 'reply text untouched', last.mes === '你捡起了一枚银色徽章，上面刻着十字。');
} catch (e) {
    console.error('crashed:', e);
    results.push({ pass: false });
} finally {
    await browser.close();
}
const ok = results.filter(r => r.pass).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
