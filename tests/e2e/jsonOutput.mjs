// 后台分析 JSON 输出模式（真实 ST + 模拟主模型 + 浏览器内拦截的「Venice」辅助 API）
import { launch, openST, mock, sendUser, waitIdle, sleep } from './lib.mjs';
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const { browser, page, consoleLines } = await launch();

const VENICE = 'https://api.venice.ai/api/v1';
const fake = { supported: true, reject400: false, replies: [], requests: [], modelFetches: 0 };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
await page.context().route('https://api.venice.ai/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = req.url();
    if (url.includes('/models')) {
        fake.modelFetches++;
        return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ data: [
            { id: 'qwen-3-8-27b', model_spec: { capabilities: { supportsResponseSchema: fake.supported } } },
        ] }) });
    }
    const body = JSON.parse(req.postData() || '{}');
    const prompt = (body.messages || []).map(m => m.content).join('\n');
    fake.requests.push({ hasFormat: !!body.response_format, format: body.response_format, prompt, model: body.model });
    if (fake.reject400 && body.response_format) {
        return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: 'response_format is not supported' }) });
    }
    const content = fake.replies.shift() ?? '<horaenochange/>';
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { completion_tokens: 10 },
    }) });
});

const setAux = (url, model, extra = {}) => page.evaluate(({ url, model, extra }) => {
    const s = SillyTavern.getContext().extensionSettings.horae;
    Object.assign(s, { auxApiEnabled: true, auxApiUrl: url, auxApiKey: 'test-key', auxApiModel: model, auxApiUseForAnalysis: true, auxApiFallbackToMain: false, ...extra });
    const set = (id, v) => { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } };
    set('horae-setting-aux-api-enabled', true);
    set('horae-setting-aux-api-url', url);
    set('horae-setting-aux-api-key', 'test-key');
    const sel = document.getElementById('horae-setting-aux-api-model');
    if (sel) {
        if (sel.tagName === 'SELECT' && ![...sel.options].some(o => o.value === model)) {
            const o = document.createElement('option'); o.value = model; o.textContent = model; sel.appendChild(o);
        }
        sel.value = model;
    }
    if ('auxApiJsonOutput' in extra) set('horae-setting-aux-api-json', extra.auxApiJsonOutput);
}, { url, model, extra });
const lastMeta = () => page.evaluate(() => { const c = SillyTavern.getContext().chat; const m = c[c.length - 1]; return { bg: m.horae_meta?._bg, scene: m.horae_meta?.scene, ts: m.horae_meta?.timestamp, events: m.horae_meta?.events }; });
const env = (o) => JSON.stringify({ notes: null, horae: '', event: '', rpg: '', tables: [], ...o });

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
    check('JSON option checkbox exists and is on by default', await page.evaluate(() => document.getElementById('horae-setting-aux-api-json')?.checked === true));

    // 1) Venice + 支持 schema：带 response_format，提示词含 JSON 说明，JSON 回复被正确解析
    await setAux(VENICE, 'qwen-3-8-27b', { auxApiJsonOutput: true });
    fake.replies.push(env({ notes: '到了教堂。', horae: 'time:2020/09/18 20:00\nlocation:教堂\ncharacters:Seraphina', event: 'event:重要|两人抵达教堂' }));
    await mock('/control', { mainQueue: ['你们走进了教堂。'], clearLogs: true });
    await sendUser(page, '去教堂。');
    await waitIdle(page, 30000);
    let r = fake.requests[fake.requests.length - 1];
    check('supported Venice model: request carries the JSON schema', r?.hasFormat && r.format?.json_schema?.strict === true && r.format.json_schema.schema.required.includes('horae'));
    check('prompt includes the JSON reply section', /=== Reply as JSON ===|═══ 以 JSON 回复 ═══/.test(r?.prompt || ''));
    let m = await lastMeta();
    check('JSON reply parsed into state', m.bg?.status === 'done' && m.scene?.location === '教堂' && m.ts?.story_date === '2020/09/18' && m.events?.length === 1, JSON.stringify(m));
    check('model capability fetched once', fake.modelFetches === 1, `fetches=${fake.modelFetches}`);

    // 2) 截断的 JSON → 自动重试（JSON 版重试说明）→ 成功
    fake.replies.push('{"notes":null,"horae":"time:2020/09/18 21:00\\nlocation:教', env({ horae: 'time:2020/09/18 21:00\nlocation:教堂·钟楼\ncharacters:Seraphina' }));
    const before = fake.requests.length;
    await mock('/control', { mainQueue: ['你们爬上钟楼。'], clearLogs: true });
    await sendUser(page, '上钟楼。');
    await waitIdle(page, 30000);
    m = await lastMeta();
    const retryReq = fake.requests[before + 1];
    check('cut-off JSON is retried and the retry succeeds', fake.requests.length - before === 2 && m.scene?.location === '教堂·钟楼', `reqs=${fake.requests.length - before} loc=${m.scene?.location}`);
    check('retry prompt asks for the complete JSON object', /\[Retry\][^\n]*JSON|【重试】[^\n]*JSON/.test(retryReq?.prompt || ''));
    check('capability is cached (no refetch)', fake.modelFetches === 1, `fetches=${fake.modelFetches}`);

    // 3) 接口拒绝 response_format → 去掉后重发；之后不再用 JSON 模式
    fake.reject400 = true;
    await setAux(VENICE, 'qwen-3-8-27b-alt', { auxApiJsonOutput: true });
    // 新模型名不在模型列表中 → 不支持；为测试 400 回退，把它加进支持列表
    fake.supported = true;
    await page.context().unroute('https://api.venice.ai/**');
    await page.context().route('https://api.venice.ai/**', async (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (req.url().includes('/models')) {
            fake.modelFetches++;
            return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ data: [
                { id: 'qwen-3-8-27b', model_spec: { capabilities: { supportsResponseSchema: fake.supported } } },
                { id: 'qwen-3-8-27b-alt', model_spec: { capabilities: { supportsResponseSchema: true } } },
                { id: 'old-model', model_spec: { capabilities: { supportsResponseSchema: false } } },
            ] }) });
        }
        const body = JSON.parse(req.postData() || '{}');
        const prompt = (body.messages || []).map(x => x.content).join('\n');
        fake.requests.push({ hasFormat: !!body.response_format, format: body.response_format, prompt, model: body.model });
        if (fake.reject400 && body.response_format) return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: 'response_format is not supported' }) });
        const content = fake.replies.shift() ?? '<horaenochange/>';
        return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }) });
    });
    fake.replies.push(env({ horae: 'time:2020/09/18 22:00\nlocation:教堂·地下室\ncharacters:Seraphina' }));
    let b = fake.requests.length;
    await mock('/control', { mainQueue: ['你们走进地下室。'], clearLogs: true });
    await sendUser(page, '下去看看。');
    await waitIdle(page, 30000);
    m = await lastMeta();
    let reqs = fake.requests.slice(b);
    check('400 on response_format → resent without it, reply still parsed', reqs.length === 2 && reqs[0].hasFormat && !reqs[1].hasFormat && m.scene?.location === '教堂·地下室', `reqs=${JSON.stringify(reqs.map(x => x.hasFormat))} loc=${m.scene?.location}`);
    fake.replies.push('<horae>\ntime:2020/09/18 22:30\nlocation:教堂·地下室·密室\ncharacters:Seraphina\n</horae>');
    b = fake.requests.length;
    await mock('/control', { mainQueue: ['你们发现了密室。'], clearLogs: true });
    await sendUser(page, '推开暗门。');
    await waitIdle(page, 30000);
    reqs = fake.requests.slice(b);
    m = await lastMeta();
    check('after a rejection the model is remembered as unsupported (tag format)', reqs.length === 1 && !reqs[0].hasFormat && !/Reply as JSON|以 JSON 回复/.test(reqs[0].prompt) && m.scene?.location === '教堂·地下室·密室', `reqs=${JSON.stringify(reqs.map(x => x.hasFormat))} loc=${m.scene?.location}`);
    fake.reject400 = false;

    // 4) 模型声明不支持 → 标签格式
    await setAux(VENICE, 'old-model', { auxApiJsonOutput: true });
    fake.replies.push('<horae>\nlocation:钟楼顶\ncharacters:Seraphina\n</horae>');
    b = fake.requests.length;
    await mock('/control', { mainQueue: ['你们回到钟楼顶。'], clearLogs: true });
    await sendUser(page, '回去。');
    await waitIdle(page, 30000);
    reqs = fake.requests.slice(b);
    check('model without schema support: tag format, no response_format', reqs.length === 1 && !reqs[0].hasFormat && !/Reply as JSON|以 JSON 回复/.test(reqs[0].prompt) && (await lastMeta()).scene?.location === '钟楼顶');

    // 5) 设置关闭 → 标签格式
    await setAux(VENICE, 'qwen-3-8-27b', { auxApiJsonOutput: false });
    fake.replies.push('<horae>\nlocation:广场\ncharacters:Seraphina\n</horae>');
    b = fake.requests.length;
    await mock('/control', { mainQueue: ['你们来到广场。'], clearLogs: true });
    await sendUser(page, '去广场。');
    await waitIdle(page, 30000);
    reqs = fake.requests.slice(b);
    check('setting off: tag format even on a supported model', reqs.length === 1 && !reqs[0].hasFormat && (await lastMeta()).scene?.location === '广场');

    // 6) 非 Venice 端点（mock）→ 从不发送 response_format
    await setAux('http://127.0.0.1:5555/v1', 'mock-aux', { auxApiJsonOutput: true });
    await mock('/control', { mainQueue: ['你们休息片刻。'], clearLogs: true });
    await sendUser(page, '休息。');
    await waitIdle(page, 30000);
    const auxLog = (await mock('/logs')).filter(l => l.type === 'aux').pop();
    check('non-Venice endpoint: no JSON section in the prompt', auxLog && !auxLog.messages.some(x => /Reply as JSON|以 JSON 回复/.test(x.content)));

    const errs = consoleLines.filter(l => /^\[(error|pageerror)\]/.test(l) && /horae/i.test(l) && !/TavernHelper/.test(l));
    check('no Horae errors in console', errs.length === 0, errs.slice(0, 3).join(' | '));
    console.log(consoleLines.filter(l => /JSON 输出|response_format/.test(l)).join('\n'));
} catch (e) { console.log('ERR', e.message.split('\n')[0]); results.push(false); }
finally {
    // 恢复成其他 E2E 套件使用的 mock 辅助 API
    try { await setAux('http://127.0.0.1:5555/v1', 'mock-aux', { auxApiJsonOutput: true }); await page.evaluate(() => SillyTavern.getContext().saveSettingsDebounced()); await sleep(1500); } catch { /* ignore */ }
    await browser.close();
}
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
