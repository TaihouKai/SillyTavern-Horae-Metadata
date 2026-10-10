/**
 * 测试辅助：在 Node 中加载真实的 horaeManager，并用本地文件模拟 fetch（加载 prompts/ 资源）
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://horae.test';

globalThis.fetch = async (url) => {
    const rel = String(url).startsWith(BASE) ? String(url).slice(BASE.length) : String(url);
    try {
        const text = await readFile(path.join(ROOT, rel), 'utf-8');
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    } catch {
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }
};

// horaeManager 在日志里会输出较多信息，测试时静默
const _log = console.log;
console.log = () => {};

const { horaeManager, createEmptyMeta } = await import('../core/horaeManager.js');
const promptDefaults = await import('../core/promptDefaults.js');
const bg = await import('../core/bgAnalysis.js');

await promptDefaults.initPromptDefaults(BASE, 'zh-CN');
await promptDefaults.ensurePromptDefaults('en');

export { horaeManager, createEmptyMeta, bg, _log as log };

/** 构造一条消息 */
export function msg(text, { user = false, name = user ? '玩家' : 'GM', swipes = null } = {}) {
    const m = { name, is_user: user, is_system: false, mes: text };
    if (swipes) {
        m.swipes = swipes;
        m.swipe_id = swipes.indexOf(text) >= 0 ? swipes.indexOf(text) : 0;
    }
    return m;
}

/** 以给定 chat 与设置初始化 horaeManager */
export function setup(chat, settings = {}) {
    const context = { chat, name1: '尤丝蒂娜', name2: 'GM' };
    horaeManager.init(context, {
        stateMode: 'metadata',
        aiOutputLanguage: 'zh-CN',
        uiLanguage: 'zh-CN',
        rpgMode: true,
        sendRpgBars: true,
        sendRpgSkills: true,
        sendRpgEquipment: true,
        sendItems: true,
        sendCharacters: true,
        sendTimeline: true,
        sendRelationships: true,
        rpgBarConfig: [{ key: 'hp', name: 'HP' }, { key: 'mp', name: 'MP' }, { key: 'sp', name: 'SP' }],
        ...settings,
    });
    if (!chat[0].horae_meta) chat[0].horae_meta = createEmptyMeta();
    return context;
}

/** 与 index.js 的 _bgCommit 使用同一个提交函数 */
export function commit(chat, idx, result) {
    const message = chat[idx];
    const job = { fp: bg.fingerprintText(message.mes), swipeId: bg.getSwipeId(message) };
    return bg.applyAnalysisResult(horaeManager, idx, result, job);
}

export function rebuildAll() {
    horaeManager.rebuildTableData();
    horaeManager.rebuildRelationships();
    horaeManager.rebuildLocationMemory();
    horaeManager.rebuildRpgData();
}

/** 解析辅助模型私有响应（与 index.js 一致：仅严格解析） */
export function parse(raw) {
    return bg.parseBgResponse(raw, (text) => horaeManager.parseHoraeTag(text));
}
