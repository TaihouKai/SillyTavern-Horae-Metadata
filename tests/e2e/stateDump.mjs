/**
 * 主模型仍在正文末尾写出裸状态行（旧卡/旧历史影响）时：
 *  - 显示层隐藏这些行，mes 原文不变
 *  - 下一回合发送给主模型的历史中去掉这些行
 *  - 状态快照包含「回复只写正文」说明
 * 前置条件同 run.mjs。
 */
import { launch, openST, mock, sendUser, check, waitIdle } from './lib.mjs';

const PROSE = '上官鹭的脚已经踩上了平衡梁的起点踏板。梁体在脚下第一次摆动，把她的重心推歪了三度。';
const DUMP = [
    'time:2021/9/19 11:03',
    'location:第七学区·运动公园·A-3竞技场·平衡梁起点踏板',
    'atmosphere:竞速高潮与转播亢奋',
    'characters:上官鹭,御坂美琴',
    'costume:上官鹭=大会统一体操服＋过膝袜',
    'item:号码牌"4"(1)|A-3白组四道号码牌=上官鹭@已装备（胸前）',
    'affection:御坂美琴=+2（兴趣上升）',
    'npc:白组一道选手|短发＝胆怯@白组一道竞争对手~性别:女~年龄:18',
    'event:重要|上官鹭越过水墙',
    '',
    'event:重要|上官鹭越过水墙（简）',
].join('\n');
const REPLY = `"——喔！！那是常盘台的选手吗！？"转播席的声音炸开。\n\n${PROSE}\n\n${DUMP}`;

const visibleText = (page, idx) => page.evaluate((i) => document.querySelector(`.mes[mesid="${i}"] .mes_text`)?.innerText || '', idx);

const results = [];
const { browser, page } = await launch();
try {
    await mock('/reset', {});
    await openST(page);
    await page.evaluate(() => window.jQuery('#horae-setting-state-mode').val('metadata').trigger('change'));
    await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId === undefined || ctx.groupId) await ctx.selectCharacterById(0);
    });
    await page.waitForTimeout(1500);
    await page.evaluate(async () => (await import('/script.js')).doNewChat({ deleteCurrentChat: false }));
    await page.waitForTimeout(2500);

    await mock('/control', { clearLogs: true, mainQueue: [REPLY, '她稳住重心，向前迈出第一步。'] });
    await sendUser(page, '冲向平衡梁');
    await waitIdle(page);
    await page.waitForTimeout(800);
    const idx = await page.evaluate(() => SillyTavern.getContext().chat.length - 1);

    const mes = await page.evaluate((i) => SillyTavern.getContext().chat[i].mes, idx);
    let shown = await visibleText(page, idx);
    check(results, 'mes keeps the original reply byte-for-byte', mes === REPLY);
    check(results, 'prose is displayed', shown.includes(PROSE) && shown.includes('转播席的声音炸开'));
    check(results, 'state lines are hidden from display', !/costume:|time:2021|npc:|event:重要|affection:/.test(shown), shown.slice(-200));

    // 重新渲染（编辑后取消 → ST 重绘正文）后仍隐藏
    await page.evaluate(async (i) => {
        const ctx = SillyTavern.getContext();
        ctx.chat[i].mes = ctx.chat[i].mes; // 原文不变
        const m = await import('/script.js');
        m.updateMessageBlock(i, ctx.chat[i]);
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, i);
    }, idx);
    await page.waitForTimeout(800);
    shown = await visibleText(page, idx);
    check(results, 'still hidden after the message is re-rendered', shown.includes(PROSE) && !/costume:|event:重要/.test(shown), shown.slice(-200));

    await mock('/control', { clearLogs: true });
    await sendUser(page, '迈出第一步');
    await waitIdle(page);
    const logs = await mock('/logs');
    const main = logs.find(l => l.type === 'main');
    const history = (main?.messages || []).filter(m => m.role === 'assistant').map(m => m.content).join('\n');
    const all = (main?.messages || []).map(m => m.content).join('\n');
    check(results, 'next request: previous reply sent without its state lines', history.includes(PROSE) && !/costume:|npc:|event:重要|time:2021/.test(history), history.slice(-200));
    check(results, 'next request: snapshot says replies are prose only', /回复只写剧情正文|story prose only/.test(all));
    const mesAfter = await page.evaluate((i) => SillyTavern.getContext().chat[i].mes, idx);
    check(results, 'mes still unchanged after sending', mesAfter === REPLY);
} catch (e) {
    console.error('crashed:', e);
    results.push({ pass: false });
} finally {
    await browser.close();
}
const ok = results.filter(r => r.pass).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
