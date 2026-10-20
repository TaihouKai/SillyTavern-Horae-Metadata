/**
 * 预设角色：用户在设置里写好的固定角色档案，跨聊天生效。
 * 只在聚合后的状态上覆盖（getLatestState 的结果），不改楼层里 AI 写的原始 npc 数据：
 * 关掉或删掉预设，原来的档案就回来了。
 *
 * 每行一个角色，格式与 npc: 行相同（不写 npc: 前缀）：
 *   名|外貌=性格@关系~性别:女~年龄:14~种族:人类~职业:学生~生日:05-05~补充:xxx~别名:A/B
 * 匹配上的角色整份档案换成预设：预设没写的字段为空，不沿用 AI 的记录。
 */

const ALIAS_KEY_RE = /^(别名|曾用名|alias|aliases)$/i;
const PRESET_FIELDS = ['appearance', 'personality', 'relationship', 'gender', 'age', 'race', 'job', 'birthday', 'note'];

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

/** 把预设覆盖到聚合后的 state.npcs 上（原地修改，只动这份聚合结果） */
export function applyPresetCharacters(npcs, config, parseNpcFields) {
    if (!npcs || !config || config.enabled === false || !config.text) return;
    if (config.text !== _cacheText) {
        _cacheText = config.text;
        _cacheParsed = parsePresetCharacters(config.text, parseNpcFields);
    }
    if (!_cacheParsed.length) return;
    for (const [name, info] of Object.entries(npcs)) {
        if (!info) continue;
        const keys = new Set([_norm(name), ...(info._aliases || []).map(_norm)]);
        const preset = _cacheParsed.find(p => keys.has(_norm(p.name)) || p.aliases.some(a => keys.has(_norm(a))));
        if (!preset) continue;
        for (const f of PRESET_FIELDS) info[f] = preset.fields[f] || '';
        delete info.description; // 旧版单字段描述，也不沿用
        // 预设的年龄是固定值，不按剧情时间推算
        info._ageRefDate = '';
        info._preset = preset.name;
    }
}
