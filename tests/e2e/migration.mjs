/**
 * 设置迁移 E2E：全新安装默认 Metadata；已有安装（无 stateMode）迁移为 Legacy；用户选择跨刷新保留
 * 直接修改 ST 的 settings.json（ST_DATA 指向 data/default-user）。运行结束后恢复原文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, openST, check } from './lib.mjs';

const ST_DATA = process.env.ST_DATA || 'C:/Users/agent/st-test/data/default-user';
const file = path.join(ST_DATA, 'settings.json');
const original = readFileSync(file, 'utf-8');
const results = [];

function rewrite(mutator) {
    const json = JSON.parse(original);
    mutator(json.extension_settings);
    writeFileSync(file, JSON.stringify(json, null, 4));
}

async function modeAfterLoad() {
    const { browser, page } = await launch();
    try {
        await openST(page, { connect: false });
        const r = await page.evaluate(() => ({
            mode: SillyTavern.getContext().extensionSettings.horae?.stateMode,
            ui: document.querySelector('#horae-setting-state-mode')?.value,
            bgOptionsVisible: getComputedStyle(document.querySelector('#horae-bg-mode-options')).display !== 'none',
            autoSummary: SillyTavern.getContext().extensionSettings.horae?.autoSummaryEnabled,
        }));
        await page.waitForTimeout(2500);
        return r;
    } finally {
        await browser.close();
    }
}

try {
    // 1) 全新安装：没有 horae 设置
    rewrite((ext) => { delete ext.horae; });
    let r = await modeAfterLoad();
    check(results, 'fresh install defaults to metadata mode', r.mode === 'metadata' && r.ui === 'metadata' && r.bgOptionsVisible, JSON.stringify(r));
    check(results, 'fresh install does not enable auto-summary', r.autoSummary === false, JSON.stringify(r));

    // 2) 已有安装升级：有 horae 设置但没有 stateMode → legacy，且其它设置保留
    rewrite((ext) => {
        const h = JSON.parse(original).extension_settings.horae || {};
        delete h.stateMode;
        h.autoSummaryEnabled = true; // 用户自己开着的设置必须原样保留
        ext.horae = h;
    });
    r = await modeAfterLoad();
    check(results, 'existing install without stateMode migrates to legacy', r.mode === 'legacy' && r.ui === 'legacy' && !r.bgOptionsVisible, JSON.stringify(r));
    check(results, 'existing user settings preserved on upgrade (auto-summary stays on)', r.autoSummary === true, JSON.stringify(r));

    // 3) 用户选择 metadata 后刷新保持
    rewrite((ext) => {
        const h = JSON.parse(original).extension_settings.horae || {};
        h.stateMode = 'metadata';
        ext.horae = h;
    });
    r = await modeAfterLoad();
    check(results, 'explicit metadata selection survives reload', r.mode === 'metadata', JSON.stringify(r));
} finally {
    writeFileSync(file, original);
    console.log(`\n${results.filter(x => x.pass).length}/${results.length} migration checks passed`);
}
