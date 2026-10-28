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
    check('fields missing from the preset keep the normal Horae value', s.npc?.relationship === '刚认识的同学', JSON.stringify(s.npc));
    check('message keeps the AI-written record', s.raw?.appearance === '金发少女', JSON.stringify(s.raw));

    const panel = await page.evaluate(() => document.querySelector('.horae-npc-item[data-npc-name="食蜂操祈"]')?.outerHTML || '');
    check('character panel shows the preset profile and badge', panel.includes('金色长发') && panel.includes('fa-user-pen'));

    await mock('/control', { mainQueue: ['她笑了笑。'], clearLogs: true });
    await sendUser(page, '你好。');
    await waitIdle(page, 30000);
    const main = (await mock('/logs')).find(l => l.type === 'main');
    const mainText = (main?.messages || []).map(m => m.content).join('\n');
    check('next turn: main model context has the preset profile', mainText.includes('金色长发，星形瞳孔') && !mainText.includes('金发少女=温柔') && mainText.includes('@刚认识的同学'));

    // 关闭后恢复 AI 档案
    const off = await page.evaluate(() => {
        $('#horae-setting-preset-chars-enabled').prop('checked', false);
        $('#horae-setting-preset-chars-apply').trigger('click');
        return window.Horae.getLatestState().npcs?.['食蜂操祈']?.appearance;
    });
    check('turning it off restores the AI profile', off === '金发少女', off);

    // 多个预设：旧设置迁移为 toaru；新建/切换/重命名/删除
    const multi = await page.evaluate(() => {
        const cfg = () => SillyTavern.getContext().extensionSettings.horae.presetCharacters;
        const appearance = () => window.Horae.getLatestState().npcs?.['食蜂操祈']?.appearance;
        const r = { migrated: cfg().presets.map(p => p.name).join(',') + '|' + cfg().active };
        $('#horae-setting-preset-chars-enabled').prop('checked', true);
        $('#horae-setting-preset-chars-apply').trigger('click');
        r.onAgain = appearance();
        window.prompt = () => '空白';
        $('#horae-preset-chars-new').trigger('click');
        r.afterNew = { names: cfg().presets.map(p => p.name).join(','), active: cfg().active, text: $('#horae-setting-preset-chars-text').val(), appearance: appearance() };
        $('#horae-preset-chars-select').val('toaru').trigger('change');
        r.afterSwitch = { active: cfg().active, textKept: $('#horae-setting-preset-chars-text').val().includes('食蜂操祈|'), appearance: appearance() };
        window.prompt = () => '学园都市';
        $('#horae-preset-chars-rename').trigger('click');
        r.afterRename = { names: cfg().presets.map(p => p.name).join(','), active: cfg().active, option: $('#horae-preset-chars-select').val() };
        $('#horae-preset-chars-select').val('空白').trigger('change');
        window.confirm = () => true;
        $('#horae-preset-chars-delete').trigger('click');
        r.afterDelete = { names: cfg().presets.map(p => p.name).join(','), active: cfg().active, appearance: appearance() };
        return r;
    });
    check('existing preset text is migrated into a preset named toaru', multi.migrated === 'toaru|toaru', multi.migrated);
    check('re-enabling applies the toaru preset again', multi.onAgain === '金色长发，星形瞳孔', multi.onAgain);
    check('new preset starts empty, becomes active, AI profile shows', multi.afterNew.names === 'toaru,空白' && multi.afterNew.active === '空白' && multi.afterNew.text === '' && multi.afterNew.appearance === '金发少女', JSON.stringify(multi.afterNew));
    check('switching back loads and applies that preset', multi.afterSwitch.active === 'toaru' && multi.afterSwitch.textKept && multi.afterSwitch.appearance === '金色长发，星形瞳孔', JSON.stringify(multi.afterSwitch));
    check('rename keeps the preset active', multi.afterRename.names === '学园都市,空白' && multi.afterRename.active === '学园都市' && multi.afterRename.option === '学园都市', JSON.stringify(multi.afterRename));
    check('delete removes the preset and falls back to the remaining one', multi.afterDelete.names === '学园都市' && multi.afterDelete.active === '学园都市' && multi.afterDelete.appearance === '金色长发，星形瞳孔', JSON.stringify(multi.afterDelete));

    const errs = consoleLines.filter(l => /^\[(error|pageerror)\]/.test(l) && /horae/i.test(l) && !/TavernHelper/.test(l));
    check('no Horae errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { console.log('ERR', e.message.split('\n')[0]); results.push(false); }
finally {
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.horae.presetCharacters = { enabled: true, text: '' }; SillyTavern.getContext().saveSettingsDebounced(); }).catch(() => {});
    await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
