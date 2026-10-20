// 预设角色：设置界面保存 → AI 写的档案被覆盖 → 角色面板与下一回合主模型上下文都用预设
import { launch, openST, mock, sendUser, waitIdle, sleep } from './lib.mjs';
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const { browser, page, consoleLines } = await launch();
const PRESET = '食蜂操祈|金色长发，星形瞳孔=傲娇腹黑~性别:女~年龄:14~职业:超能力者第五位~别名:女王';

try {
    await mock('/reset', {});
    await openST(page);
    await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        let id = ctx.characters.findIndex(c => c.name === 'Seraphina'); if (id < 0) id = 0;
        if (String(ctx.characterId) !== String(id)) await ctx.selectCharacterById(id);
    });
    await sleep(1500);
    await page.evaluate(async () => { const m = await import('/script.js'); await m.doNewChat({ deleteCurrentChat: false }); });
    await sleep(2500);

    // 通过设置界面保存预设
    const status = await page.evaluate((text) => {
        $('#horae-setting-preset-chars-enabled').prop('checked', true);
        $('#horae-setting-preset-chars-text').val(text);
        $('#horae-setting-preset-chars-apply').trigger('click');
        return { saved: SillyTavern.getContext().extensionSettings.horae.presetCharacters, status: $('#horae-setting-preset-chars-status').text() };
    }, PRESET);
    check('apply saves the preset text to settings', status.saved?.text === PRESET && status.saved?.enabled === true);
    check('status shows the parsed character', status.status.includes('食蜂操祈'), status.status);

    const reply = '<horae>\ntime:2020/09/18 20:00\nlocation:学园都市\ncharacters:Seraphina,食蜂操祈\nnpc:食蜂操祈|金发少女=温柔@刚认识的同学~性别:女~年龄:16\n</horae>';
    await mock('/control', { auxRules: [{ match: '金发少女向你走来', response: reply }], mainQueue: ['一位金发少女向你走来。'], clearLogs: true });
    await sendUser(page, '我走进学园都市。');
    await waitIdle(page, 30000);

    const s = await page.evaluate(() => {
        const c = SillyTavern.getContext().chat;
        return { npc: window.Horae.getLatestState().npcs?.['食蜂操祈'] || null, raw: c[c.length - 1].horae_meta?.npcs?.['食蜂操祈'] || null };
    });
    check('aggregated profile uses the preset fields', s.npc?.appearance === '金色长发，星形瞳孔' && s.npc?.personality === '傲娇腹黑' && s.npc?.age === '14', JSON.stringify(s.npc));
    check('fields missing from the preset are empty, not the AI value', s.npc?.relationship === '' && s.npc?.race === '', JSON.stringify(s.npc));
    check('message keeps the AI-written record', s.raw?.appearance === '金发少女', JSON.stringify(s.raw));

    const panel = await page.evaluate(() => document.querySelector('.horae-npc-item[data-npc-name="食蜂操祈"]')?.outerHTML || '');
    check('character panel shows the preset profile and badge', panel.includes('金色长发') && panel.includes('fa-user-pen'));

    await mock('/control', { mainQueue: ['她笑了笑。'], clearLogs: true });
    await sendUser(page, '你好。');
    await waitIdle(page, 30000);
    const main = (await mock('/logs')).find(l => l.type === 'main');
    const mainText = (main?.messages || []).map(m => m.content).join('\n');
    check('next turn: main model context has the preset profile', mainText.includes('金色长发，星形瞳孔') && !mainText.includes('金发少女=温柔') && !mainText.includes('@刚认识的同学'));

    // 角色面板手动填写预设没写的字段：保留手动值；预设写了的字段仍以预设为准
    const edited = await page.evaluate(async () => {
        document.querySelector('.horae-item-edit-btn[data-edit-type="npc"][data-edit-name="食蜂操祈"]').click();
        await new Promise(r => setTimeout(r, 500));
        document.getElementById('edit-npc-relationship').value = '同班同学';
        document.getElementById('edit-npc-personality').value = '温柔';
        document.getElementById('edit-modal-save').click();
        await new Promise(r => setTimeout(r, 1500));
        const c = SillyTavern.getContext().chat;
        return { npc: window.Horae.getLatestState().npcs?.['食蜂操祈'], manual: c[0].horae_meta?._npcManual?.['食蜂操祈'] };
    });
    check('manual value fills a field the preset leaves out', edited.npc?.relationship === '同班同学', JSON.stringify(edited));
    check('preset field still wins over a manual edit', edited.npc?.personality === '傲娇腹黑');
    check('fields left empty stay empty (AI race/age not used)', edited.npc?.race === '' && edited.npc?.birthday === '');
    await mock('/control', { auxRules: [{ match: '她换了座位', response: '<horae>\nnpc:食蜂操祈|金发少女=阴险@盟友~种族:人类\n</horae>' }], mainQueue: ['她换了座位。'], clearLogs: true });
    await sendUser(page, '上课了。');
    await waitIdle(page, 30000);
    const after = await page.evaluate(() => window.Horae.getLatestState().npcs?.['食蜂操祈']);
    check('a later AI update changes nothing', after?.relationship === '同班同学' && after?.personality === '傲娇腹黑' && after?.race === '', JSON.stringify(after));

    // 关闭后恢复 AI 档案
    const off = await page.evaluate(() => {
        $('#horae-setting-preset-chars-enabled').prop('checked', false);
        $('#horae-setting-preset-chars-apply').trigger('click');
        return window.Horae.getLatestState().npcs?.['食蜂操祈']?.appearance;
    });
    check('turning it off restores the AI profile', off === '金发少女', off);

    const errs = consoleLines.filter(l => /^\[(error|pageerror)\]/.test(l) && /horae/i.test(l) && !/TavernHelper/.test(l));
    check('no Horae errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { console.log('ERR', e.message.split('\n')[0]); results.push(false); }
finally {
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.horae.presetCharacters = { enabled: true, text: '' }; SillyTavern.getContext().saveSettingsDebounced(); }).catch(() => {});
    await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
