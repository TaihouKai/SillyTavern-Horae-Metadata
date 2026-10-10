/** 打印一次真实的后台分析请求（辅助模型收到的完整消息），用于人工审阅提示词 */
import { writeFileSync } from 'node:fs';
import { launch, openST, mock, waitIdle } from './lib.mjs';

const lang = process.argv[2] || '';
const out = process.argv[3] || 'aux-prompt.txt';
const { browser, page } = await launch();
try {
    await openST(page);
    if (lang) {
        await page.evaluate((l) => { SillyTavern.getContext().extensionSettings.horae.aiOutputLanguage = l; }, lang);
    }
    await mock('/control', { clearLogs: true });
    const idx = await page.evaluate(() => {
        const chat = SillyTavern.getContext().chat;
        for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return i;
        return -1;
    });
    await page.evaluate((i) => window.Horae.background.reanalyze(i), idx);
    await waitIdle(page);
    const logs = await mock('/logs');
    const aux = logs.find(l => l.type === 'aux');
    const text = (aux?.messages || []).map(m => `===== ${m.role} =====\n${m.content}`).join('\n\n');
    writeFileSync(out, text);
    console.log(`wrote ${text.length} chars for message #${idx} to ${out}`);
} finally {
    await browser.close();
}
