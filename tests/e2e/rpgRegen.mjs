// 属性条自动回复：RPG 页按钮 → 设置窗 → HUD 与下一回合主模型上下文显示回复后的数值，楼层数据不变
import { launch, openST, mock, sendUser, waitIdle, sleep } from './lib.mjs';
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const { browser, page, consoleLines } = await launch();

try {
    await mock('/reset', {});
    await openST(page);
    await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        let id = ctx.characters.findIndex(c => c.name === 'Seraphina'); if (id < 0) id = 0;
        if (String(ctx.characterId) !== String(id)) await ctx.selectCharacterById(id);
        const s = ctx.extensionSettings.horae;
        s.rpgMode = true; s.sendRpgBars = true; s.rpgRegen = {};
    });
    await sleep(1500);
    await page.evaluate(async () => { const m = await import('/script.js'); await m.doNewChat({ deleteCurrentChat: false }); });
    await sleep(2500);
    const user = await page.evaluate(() => SillyTavern.getContext().name1);

    const hurt = `<horae>\ntime:2020/09/20 12:00\nlocation:学园都市\ncharacters:${user}\n</horae>\n<horaerpg>\nhp:${user}=60/100\nmp:${user}=20/100\n</horaerpg>`;
    const later = `<horae>\ntime:2020/09/20 14:30\nlocation:学园都市\ncharacters:${user}\n</horae>`;
    await mock('/control', { auxRules: [{ match: '你被擦伤了', response: hurt }, { match: '下午过去了', response: later }], mainQueue: ['你被擦伤了。', '下午过去了。'], clearLogs: true });
    await sendUser(page, '我走进学园都市。');
    await waitIdle(page, 30000);
    await sendUser(page, '休息一下。');
    await waitIdle(page, 30000);

    const before = await page.evaluate((u) => window.Horae.getRpgState(0)?.bars?.[u], user);
    check('regen off: bars stay at the recorded value', before?.hp?.[0] === 60 && before?.mp?.[0] === 20, JSON.stringify(before));

    // RPG 页按钮 → 设置窗：HP 10%/小时开启，MP 保持关闭
    const dlg = await page.evaluate(() => {
        $('#horae-rpg-bar-regen').trigger('click');
        const modal = [...document.querySelectorAll('.horae-modal')].pop();
        const rows = [...modal.querySelectorAll('.horae-rpg-regen-row')].map(r => r.dataset.key);
        const hp = modal.querySelector('.horae-rpg-regen-row[data-key="hp"]');
        hp.querySelector('.horae-rpg-regen-pct').value = '10';
        hp.querySelector('.horae-rpg-regen-on-check').checked = true;
        modal.querySelector('.horae-rpg-regen-ok').click();
        return { rows, open: !!document.querySelector('.horae-rpg-regen-row'), saved: SillyTavern.getContext().extensionSettings.horae.rpgRegen, lit: document.getElementById('horae-rpg-bar-regen').classList.contains('horae-rpg-regen-on') };
    });
    check('dialog lists every bar', ['hp', 'mp', 'sp'].every(k => dlg.rows.includes(k)), dlg.rows.join(','));
    check('confirm saves the setting and closes the dialog', dlg.saved?.hp?.on === true && dlg.saved?.hp?.pct === 10 && dlg.saved?.mp?.on === false && !dlg.open, JSON.stringify(dlg.saved));
    check('button is highlighted while a bar is on', dlg.lit);

    const s = await page.evaluate((u) => {
        const c = SillyTavern.getContext().chat;
        const hud = document.querySelector(`.mes[mesid="${c.length - 1}"] .horae-rpg-hud`)?.textContent || '';
        let raw = null;
        for (const m of c) if (m.horae_meta?._rpgChanges?.bars?.[u]) raw = m.horae_meta._rpgChanges.bars[u].hp;
        return { bars: window.Horae.getRpgState(0)?.bars?.[u], hud, raw };
    }, user);
    check('HP regenerates 10% per story hour (60 → 85 after 2.5 h)', s.bars?.hp?.[0] === 85, JSON.stringify(s.bars));
    check('MP stays (its regen is off)', s.bars?.mp?.[0] === 20);
    check('HUD on the latest reply shows the regenerated value', s.hud.includes('85'), s.hud.replace(/\s+/g, ' ').slice(0, 120));
    check('message data keeps the recorded value', s.raw?.[0] === 60, JSON.stringify(s.raw));

    await mock('/control', { mainQueue: ['好的。'], clearLogs: true });
    await sendUser(page, '继续。');
    await waitIdle(page, 30000);
    const main = (await mock('/logs')).find(l => l.type === 'main');
    const mainText = (main?.messages || []).map(m => m.content).join('\n');
    check('next turn: main model context has the regenerated HP', /85\/100/.test(mainText) && !/60\/100/.test(mainText));

    const errs = consoleLines.filter(l => /^\[(error|pageerror)\]/.test(l) && /horae/i.test(l) && !/TavernHelper/.test(l));
    check('no Horae errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { console.log('ERR', e.message.split('\n')[0]); results.push(false); }
finally {
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.horae.rpgRegen = {}; SillyTavern.getContext().saveSettingsDebounced(); }).catch(() => {});
    await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
