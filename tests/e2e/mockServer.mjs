/**
 * E2E 用的 OpenAI 兼容模拟端点
 *  - 主模型（ST 后端经 Custom OpenAI 兼容源调用）：按脚本返回纯剧情
 *  - 辅助模型（Horae 在浏览器中直连）：按剧情关键字返回私有状态标签，可注入延迟/失败/格式错误
 *  - /v1/embeddings：确定性哈希向量，供 Horae 向量记忆使用
 * 所有请求记录在 /logs，供测试检查主模型实际收到的提示词。
 *
 * 用法：node tests/e2e/mockServer.mjs [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 5555);

const state = {
    logs: [],
    mainQueue: [],          // 依次返回的主模型剧情
    auxRules: [],           // [{ match: '子串', response: '...' }]
    auxDelayMs: 0,
    auxFailNext: 0,         // 接下来 N 次返回 500
    auxMalformedNext: 0,    // 接下来 N 次返回无标签文本
};

const isAux = (messages) => messages.some(m => typeof m.content === 'string'
    && (m.content.includes('【Horae 后台状态分析器】') || m.content.includes('[Horae Background State Analyzer]')));

function storyOf(messages) {
    const text = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const m = text.match(/<story>\n?([\s\S]*?)\n?<\/story>/);
    return m ? m[1] : '';
}

function lastUser(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return String(messages[i].content || '');
    }
    return '';
}

function embed(text) {
    const dim = 64;
    const v = new Array(dim).fill(0);
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        v[(c * 31 + (i % 7)) % dim] += 1;
        if (i + 1 < s.length) v[(c * 17 + s.charCodeAt(i + 1)) % dim] += 0.5;
    }
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map(x => x / n);
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        ...headers,
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function completion(content, model) {
    return {
        id: 'mock-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
}

function streamCompletion(res, content, model) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
    });
    const chunks = content.match(/[\s\S]{1,40}/g) || [''];
    for (const c of chunks) {
        res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const url = req.url.replace(/^\/+/, '/');

    if (url === '/logs' && req.method === 'GET') return send(res, 200, state.logs);
    if (url === '/reset' && req.method === 'POST') {
        Object.assign(state, { logs: [], mainQueue: [], auxRules: [], auxDelayMs: 0, auxFailNext: 0, auxMalformedNext: 0 });
        return send(res, 200, { ok: true });
    }
    if (url === '/control' && req.method === 'POST') {
        for (const k of ['mainQueue', 'auxRules', 'auxDelayMs', 'auxFailNext', 'auxMalformedNext']) {
            if (body[k] !== undefined) state[k] = body[k];
        }
        if (body.clearLogs) state.logs = [];
        return send(res, 200, { ok: true, state: { ...state, logs: state.logs.length } });
    }
    if (url.endsWith('/models')) {
        return send(res, 200, { object: 'list', data: [{ id: 'mock-main', object: 'model' }, { id: 'mock-aux', object: 'model' }, { id: 'mock-embed', object: 'model' }] });
    }
    if (url.endsWith('/embeddings')) {
        const input = Array.isArray(body.input) ? body.input : [body.input];
        state.logs.push({ type: 'embed', at: Date.now(), count: input.length });
        return send(res, 200, { object: 'list', data: input.map((t, i) => ({ object: 'embedding', index: i, embedding: embed(t) })), model: body.model || 'mock-embed' });
    }
    if (url.endsWith('/chat/completions')) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (isAux(messages)) {
            const story = storyOf(messages);
            const entry = { type: 'aux', at: Date.now(), story, messages, model: body.model };
            state.logs.push(entry);
            if (state.auxDelayMs) await sleep(state.auxDelayMs);
            if (state.auxFailNext > 0) {
                state.auxFailNext--;
                entry.result = 'http500';
                return send(res, 500, { error: { message: 'mock aux failure' } });
            }
            if (state.auxMalformedNext > 0) {
                state.auxMalformedNext--;
                entry.result = 'malformed';
                return send(res, 200, completion('time: 2004/2/1\nlocation: somewhere\n（这不是合法的标签输出）', body.model));
            }
            const rule = state.auxRules.find(r => story.includes(r.match));
            const content = rule ? rule.response : '<horaenochange/>';
            entry.result = rule ? `rule:${rule.match}` : 'nochange';
            entry.response = content;
            return send(res, 200, completion(content, body.model));
        }
        const content = state.mainQueue.length ? state.mainQueue.shift() : `默认叙事：GM 回应了「${lastUser(messages).slice(0, 30)}」。`;
        state.logs.push({ type: 'main', at: Date.now(), messages, stream: !!body.stream, model: body.model, response: content });
        if (body.stream) return streamCompletion(res, content, body.model);
        return send(res, 200, completion(content, body.model));
    }
    send(res, 404, { error: 'not found', url });
});

server.listen(PORT, () => console.log(`[mock] listening on http://127.0.0.1:${PORT}`));
