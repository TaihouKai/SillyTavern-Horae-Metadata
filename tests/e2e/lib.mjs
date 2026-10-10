/**
 * E2E 驱动工具：用 Playwright 操作真实 SillyTavern 前端
 * 需要：ST 运行于 ST_URL，mockServer 运行于 MOCK_URL；playwright 由 PLAYWRIGHT_PATH 指定的目录提供
 */
import { createRequire } from 'node:module';

const require = createRequire(process.env.PLAYWRIGHT_PATH || import.meta.url);
const { chromium } = require('playwright');

export const ST_URL = process.env.ST_URL || 'http://127.0.0.1:8000';
export const MOCK_URL = process.env.MOCK_URL || 'http://127.0.0.1:5555';

export async function mock(path, body) {
    const resp = await fetch(MOCK_URL + path, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return resp.json();
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function launch({ headless = true } = {}) {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
    page.on('dialog', (d) => d.accept());
    return { browser, page, consoleLines };
}

export async function openST(page, opts = {}) {
    await page.goto(ST_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.SillyTavern?.getContext && document.querySelector('#horae-setting-state-mode'), null, { timeout: 90000 });
    await page.waitForTimeout(1500);
    await dismissDialogs(page);
    if (opts.connect !== false) await connect(page);
}

/** 连接主 API（Chat Completion），等待在线 */
export async function connect(page) {
    for (let k = 0; k < 3; k++) {
        const status = await page.evaluate(() => SillyTavern.getContext().onlineStatus);
        if (status && status !== 'no_connection') return status;
        await page.evaluate(() => document.querySelector('#api_button_openai')?.click());
        await page.waitForTimeout(2500);
    }
    return page.evaluate(() => SillyTavern.getContext().onlineStatus);
}

/** 关闭 ST 首次启动引导等弹窗（点击确定） */
export async function dismissDialogs(page) {
    for (let k = 0; k < 5; k++) {
        const open = await page.$('dialog[open] .popup-button-ok');
        if (!open) return;
        await open.click().catch(() => {});
        await page.waitForTimeout(800);
    }
}

/** 等待条件成立（在页面内求值） */
export async function waitFor(page, fn, arg, timeout = 30000) {
    await page.waitForFunction(fn, arg, { timeout, polling: 200 });
}

export async function ctxEval(page, fn, arg) {
    return page.evaluate(fn, arg);
}

/** 读取当前聊天的精简快照 */
export async function chatSnapshot(page) {
    return page.evaluate(() => {
        const ctx = SillyTavern.getContext();
        return ctx.chat.map((m, i) => ({
            i, name: m.name, is_user: m.is_user, mes: m.mes, swipe_id: m.swipe_id,
            swipes: m.swipes?.length || 0,
            bg: m.horae_meta?._bg || null,
            meta: m.horae_meta || null,
            cacheKeys: m.horae_bg_swipes ? Object.keys(m.horae_bg_swipes) : [],
        }));
    });
}

export async function rpgData(page) {
    return page.evaluate(() => SillyTavern.getContext().chat?.[0]?.horae_meta?.rpg || null);
}

/** 发送一条用户消息并等待 AI 回复渲染完成 */
export async function sendUser(page, text) {
    const before = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await page.fill('#send_textarea', text);
    await page.click('#send_but');
    await waitFor(page, (n) => {
        const ctx = SillyTavern.getContext();
        return ctx.chat.length >= n + 2 && !document.querySelector('#mes_stop:not([style*="display: none"])')?.offsetParent;
    }, before, 60000);
    await page.waitForTimeout(300);
}

/** 等待某楼层后台分析达到指定状态 */
export async function waitBg(page, idx, statuses = ['done', 'nochange'], timeout = 30000) {
    await waitFor(page, ({ idx, statuses }) => {
        const m = SillyTavern.getContext().chat[idx];
        const bg = m?.horae_meta?._bg;
        return !!bg && statuses.includes(bg.status);
    }, { idx, statuses }, timeout);
}

export function check(results, name, cond, detail = '') {
    results.push({ name, pass: !!cond, detail });
    const mark = cond ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 等待当前聊天的后台分析全部完成 */
export async function waitIdle(page, timeoutMs = 60000) {
    return page.evaluate((t) => window.Horae?.background?.waitForIdle(t), timeoutMs);
}

/** 记录当前聊天（角色 + chat 文件），重载后重新打开同一聊天 */
export async function currentChatRef(page) {
    return page.evaluate(() => {
        const ctx = SillyTavern.getContext();
        return { chatId: ctx.getCurrentChatId(), characterId: ctx.characterId, groupId: ctx.groupId || null };
    });
}

export async function reopenChat(page, ref) {
    await page.evaluate(async (ref) => {
        const ctx = SillyTavern.getContext();
        if (ref.groupId) {
            await ctx.openGroupChat(ref.groupId, ref.chatId);
        } else {
            if (String(ctx.characterId) !== String(ref.characterId)) await ctx.selectCharacterById(Number(ref.characterId));
            await new Promise(r => setTimeout(r, 1000));
            if (ctx.getCurrentChatId() !== ref.chatId) await SillyTavern.getContext().openCharacterChat(ref.chatId);
        }
    }, ref);
    await page.waitForFunction((id) => SillyTavern.getContext().getCurrentChatId() === id, ref.chatId, { timeout: 30000 });
    await page.waitForTimeout(2500);
}
