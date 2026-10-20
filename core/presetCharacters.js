/**
 * 预设角色：用户在设置里写好的固定角色档案，跨聊天生效。
 * 只在聚合后的状态上覆盖（getLatestState 的结果），不改楼层里 AI 写的原始 npc 数据：
 * 关掉或删掉预设，原来的档案就回来了。
 *
 * 每行一个角色，格式与 npc: 行相同（不写 npc: 前缀）：
 *   名|外貌=性格@关系~性别:女~年龄:14~种族:人类~职业:学生~生日:05-05~补充:xxx~别名:A/B
 * 匹配上的角色，每个字段：
 *   预设写了 → 用预设；
 *   预设没写、用户在角色面板里手动填过 → 用手动值（记录在 chat[0].horae_meta._npcManual）；
 *   都没有 → 空，不用 AI 写的值。
 */

const ALIAS_KEY_RE = /^(别名|曾用名|alias|aliases)$/i;
export const PRESET_FIELDS = ['appearance', 'personality', 'relationship', 'gender', 'age', 'race', 'job', 'birthday', 'note'];
export const MANUAL_META_KEY = '_npcManual';

const _norm = (s) => String(s || '').trim().toLowerCase();

/** 从一行里取出 ~别名:A/B（_parseNpcFields 不认识这个键，单独解析） */
function _extractAliases(line) {
    const aliases = [];
    for (const part of line.split('~').slice(1)) {
        const idx = part.indexOf(':') >= 0 ? part.indexOf(':') : part.indexOf('：');
        if (idx <= 0) continue;
        if (!ALIAS_KEY_RE.test(part.substring(0, idx).trim())) continue;
        for (const a of part.substring(idx + 1).split(/[\/／,，、]/)) {
            const v = a.trim();
            if (v) aliases.push(v);
        }
    }
    return aliases;
}

/**
 * 解析预设文本。parseNpcFields 传 horaeManager._parseNpcFields，保证格式与分析器的 npc: 行完全一致。
 * @returns {Array<{name: string, aliases: string[], fields: Object}>}
 */
export function parsePresetCharacters(text, parseNpcFields) {
    const presets = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        let line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        line = line.replace(/^npc[:：]\s*/i, '');
        const info = parseNpcFields(line) || {};
        const name = String(info._name || '').trim();
        if (!name) continue;
        const fields = {};
        for (const f of PRESET_FIELDS) {
            if (typeof info[f] === 'string' && info[f].trim()) fields[f] = info[f].trim();
        }
        presets.push({ name, aliases: _extractAliases(line), fields });
    }
    return presets;
}

let _cacheText = null;
let _cacheParsed = [];

function _activePresets(config, parseNpcFields) {
    if (!config || config.enabled === false || !config.text) return [];
    if (config.text !== _cacheText) {
        _cacheText = config.text;
        _cacheParsed = parsePresetCharacters(config.text, parseNpcFields);
    }
    return _cacheParsed;
}

/** 按角色名与其曾用名找匹配的预设 */
export function findPresetFor(name, aliases, config, parseNpcFields) {
    const presets = _activePresets(config, parseNpcFields);
    if (!presets.length) return null;
    const keys = new Set([_norm(name), ...(aliases || []).map(_norm)]);
    return presets.find(p => keys.has(_norm(p.name)) || p.aliases.some(a => keys.has(_norm(a)))) || null;
}

/** 把预设覆盖到聚合后的 state.npcs 上（原地修改，只动这份聚合结果）；manual 为 chat[0] 上的手动值表 */
export function applyPresetCharacters(npcs, config, parseNpcFields, manual) {
    if (!npcs || !_activePresets(config, parseNpcFields).length) return;
    for (const [name, info] of Object.entries(npcs)) {
        if (!info) continue;
        const preset = findPresetFor(name, info._aliases, config, parseNpcFields);
        if (!preset) continue;
        const own = manual?.[name] || {};
        for (const f of PRESET_FIELDS) info[f] = preset.fields[f] || own[f] || '';
        delete info.description; // 旧版单字段描述，也不沿用
        // 预设的年龄是固定值，不按剧情时间推算
        info._ageRefDate = '';
        info._preset = preset.name;
    }
}

/**
 * 记录用户在角色面板里手动填写的字段（编辑/新增角色时调用）。
 * 只记录 data 里出现的字段；与预设相同的值不记（那是面板回显的预设）；清空即删除手动值。
 */
export function recordManualNpcFields(chat, name, data, config, parseNpcFields, aliases) {
    const meta = chat?.[0]?.horae_meta;
    if (!meta || !name || !data) return;
    const preset = findPresetFor(name, aliases, config, parseNpcFields);
    const store = meta[MANUAL_META_KEY] || {};
    const own = { ...(store[name] || {}) };
    for (const f of PRESET_FIELDS) {
        if (data[f] === undefined) continue;
        const v = String(data[f] ?? '').trim();
        if (preset?.fields[f] && v === preset.fields[f]) continue;
        if (v) own[f] = v; else delete own[f];
    }
    if (Object.keys(own).length) store[name] = own; else delete store[name];
    if (Object.keys(store).length) meta[MANUAL_META_KEY] = store; else delete meta[MANUAL_META_KEY];
}

/** 角色改名时迁移手动值 */
export function renameManualNpc(chat, oldName, newName) {
    const store = chat?.[0]?.horae_meta?.[MANUAL_META_KEY];
    if (!store?.[oldName] || oldName === newName) return;
    store[newName] = { ...(store[newName] || {}), ...store[oldName] };
    delete store[oldName];
}
