/**
 * Horae - Persona 开局状态（确定性初始化）
 *
 * 三类数据严格分开：
 *  1. 可复用模板（extension settings，按原生 Persona 头像键绑定）
 *  2. 本聊天基线（chat_metadata.horaePersonaBootstrap，开局时冻结一次，标记与数据同一对象）
 *  3. 剧情增量（各楼层 horae_meta，照常记录）
 *
 *  某一时刻的状态 = fold(本聊天基线, 截至该时刻的有效剧情增量)
 *
 * 本模块只含纯函数（校验、构建、折叠辅助、资格判定、补录计划），不访问 DOM / ST 全局。
 */

import { getItemBaseName } from './horaeManager.js';

export const PB_SCHEMA = 1;
export const PB_META_KEY = 'horaePersonaBootstrap';
export const PB_SETTINGS_KEY = 'personaProfiles';

export const PB_STATUS = Object.freeze({
    APPLIED: 'applied',     // 新聊天开局前由模板初始化
    INHERITED: 'inherited', // 继承自其他聊天（carryover），不再套用模板
    REPAIRED: 'repaired',   // 旧聊天：仅在当前边界补录了用户选择的缺失条目
    CLEARED: 'cleared',     // 用户显式清空；普通发送不会自动重建
});

// 不能作为属性条键：会与 <horaerpg> 行协议冲突
const RESERVED_BAR_KEYS = new Set([
    'status', 'skill', 'equip', 'unequip', 'rep', 'level', 'xp', 'currency', 'attr', 'base',
    'item', 'event', 'time', 'date', 'location', 'atmosphere', 'characters', 'costume',
    'affection', 'npc', 'agenda', 'rel', 'mood', 'scene_desc',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof']);
const BAR_KEY_RE = /^[a-z][a-z0-9_]{0,9}$/;
const IMPORTANCE = new Set(['', '!', '!!']);

const str = (v) => (v == null ? '' : String(v));
const oneLine = (v) => !/[\r\n]/.test(v);

/** 严格解析非负整数（数字或纯数字字符串）；其他一律 null，绝不把 0 当作缺失 */
export function parseNonNegInt(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
    const s = str(v).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
}

function newId(prefix) {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 新的空模板（默认不启用） */
export function createEmptyProfile(personaKey = '', nameHint = '') {
    return {
        schema: PB_SCHEMA,
        id: newId('pp_'),
        revision: 0,
        enabled: false,
        personaKey,
        nameHint,
        bars: [],
        skills: [],
        items: [],
        strongholds: [],
        updatedAt: '',
    };
}

/** 可见预设：HP/MP/SP 100/100（选择即视为用户明确配置） */
export function presetBars() {
    return [
        { key: 'hp', name: 'HP', desc: '', color: '#ef4444', current: 100, max: 100 },
        { key: 'mp', name: 'MP', desc: '', color: '#3b82f6', current: 100, max: 100 },
        { key: 'sp', name: 'SP', desc: '', color: '#22c55e', current: 100, max: 100 },
    ];
}

/** 物品最终名称：数量/单位编码进名称，复用现有基本名规则 */
export function composeItemName(name, quantity, unit) {
    const base = str(name).trim();
    const u = str(unit).trim();
    if (quantity === 1 && !u) return base;
    return `${base}(${quantity}${u})`;
}

/**
 * 校验并规范化模板。不做静默钳制：任何非法值都成为 error。
 * @returns {{ok:boolean, errors:{path:string, code:string, params?:object}[], warnings:{path:string, code:string, params?:object}[], normalized:object|null}}
 */
export function validateProfile(profile) {
    const errors = [];
    const warnings = [];
    const err = (path, code, params) => errors.push({ path, code, params });
    const warn = (path, code, params) => warnings.push({ path, code, params });
    if (!profile || typeof profile !== 'object') {
        err('', 'notObject');
        return { ok: false, errors, warnings, normalized: null };
    }

    // ---- 属性条 ----
    const bars = [];
    const barKeys = new Set();
    (Array.isArray(profile.bars) ? profile.bars : []).forEach((b, i) => {
        const p = `bars[${i}]`;
        const rawKey = str(b?.key).trim();
        const key = rawKey.toLowerCase();
        if (!rawKey) { err(p, 'barKeyMissing'); return; }
        if (key !== rawKey) warn(p, 'barKeyLowercased', { from: rawKey, to: key });
        if (UNSAFE_KEYS.has(key)) { err(p, 'barKeyUnsafe', { key }); return; }
        if (RESERVED_BAR_KEYS.has(key)) { err(p, 'barKeyReserved', { key }); return; }
        if (!BAR_KEY_RE.test(key)) { err(p, 'barKeyInvalid', { key }); return; }
        if (barKeys.has(key)) { err(p, 'barKeyDuplicate', { key }); return; }
        barKeys.add(key);
        const current = parseNonNegInt(b?.current);
        const max = parseNonNegInt(b?.max);
        if (current === null) err(p, 'barCurrentInvalid', { key, value: str(b?.current) });
        if (max === null) err(p, 'barMaxInvalid', { key, value: str(b?.max) });
        else if (max === 0) err(p, 'barMaxZero', { key });
        if (current !== null && max !== null && max > 0 && current > max) err(p, 'barCurrentOverMax', { key, current, max });
        const name = str(b?.name).trim() || key.toUpperCase();
        if (!oneLine(name)) err(p, 'barNameMultiline', { key });
        const color = str(b?.color).trim();
        if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) err(p, 'barColorInvalid', { key, value: color });
        bars.push({ key, name, desc: str(b?.desc), color: color || '', current, max });
    });

    // ---- 技能 ----
    const skills = [];
    const skillNames = new Set();
    (Array.isArray(profile.skills) ? profile.skills : []).forEach((s, i) => {
        const p = `skills[${i}]`;
        const name = str(s?.name).trim();
        if (!name) { err(p, 'skillNameMissing'); return; }
        if (!oneLine(name)) { err(p, 'skillNameMultiline', { name }); return; }
        if (skillNames.has(name)) { err(p, 'skillDuplicate', { name }); return; }
        skillNames.add(name);
        const level = str(s?.level).trim();
        if (!oneLine(level)) err(p, 'skillLevelMultiline', { name });
        // 描述原样保留（多行、| = @、标签样文本都合法）
        skills.push({ name, level, desc: str(s?.desc) });
    });

    // ---- 物品 ----
    const items = [];
    const itemBases = new Map();
    (Array.isArray(profile.items) ? profile.items : []).forEach((it, i) => {
        const p = `items[${i}]`;
        const name = str(it?.name).trim();
        if (!name) { err(p, 'itemNameMissing'); return; }
        if (!oneLine(name)) { err(p, 'itemNameMultiline', { name }); return; }
        if (getItemBaseName(name) !== name) { err(p, 'itemNameHasQuantity', { name }); return; }
        const quantity = (it?.quantity === undefined || it?.quantity === null || str(it.quantity).trim() === '') ? 1 : parseNonNegInt(it.quantity);
        if (quantity === null || quantity < 1) { err(p, 'itemQuantityInvalid', { name, value: str(it?.quantity) }); return; }
        const unit = str(it?.unit).trim();
        if (unit && (!oneLine(unit) || /[\d()（）]/.test(unit) || unit.length > 6)) { err(p, 'itemUnitInvalid', { name, value: unit }); return; }
        const fullName = composeItemName(name, quantity, unit);
        if (getItemBaseName(fullName) !== name) { err(p, 'itemUnitInvalid', { name, value: unit }); return; }
        const baseKey = name.toLowerCase();
        if (itemBases.has(baseKey)) { err(p, 'itemDuplicate', { name, other: itemBases.get(baseKey) }); return; }
        itemBases.set(baseKey, name);
        const importance = str(it?.importance).trim();
        if (!IMPORTANCE.has(importance)) { err(p, 'itemImportanceInvalid', { name, value: importance }); return; }
        const holder = str(it?.holder).trim();
        const location = str(it?.location).trim();
        const icon = str(it?.icon).trim();
        if (!oneLine(holder) || !oneLine(location) || !oneLine(icon)) { err(p, 'itemFieldMultiline', { name }); return; }
        items.push({ name, quantity, unit, fullName, description: str(it?.description), holder, location, icon, importance });
    });

    // ---- 据点 ----
    const strongholds = [];
    const rawSh = Array.isArray(profile.strongholds) ? profile.strongholds : [];
    const ids = new Set();
    rawSh.forEach((n, i) => {
        const p = `strongholds[${i}]`;
        const name = str(n?.name).trim();
        if (!name) { err(p, 'shNameMissing'); return; }
        if (!oneLine(name) || name.includes('>')) { err(p, 'shNameInvalid', { name }); return; }
        let id = str(n?.id).trim();
        if (id && (UNSAFE_KEYS.has(id.toLowerCase()) || !/^[\w-]{1,40}$/.test(id))) { err(p, 'shIdInvalid', { name, id }); return; }
        if (!id) id = `shb_${i + 1}`;
        if (ids.has(id)) { err(p, 'shIdDuplicate', { name, id }); return; }
        ids.add(id);
        let level = null;
        if (n?.level !== undefined && n?.level !== null && str(n.level).trim() !== '') {
            level = parseNonNegInt(n.level);
            if (level === null) { err(p, 'shLevelInvalid', { name, value: str(n.level) }); return; }
        }
        const parent = str(n?.parent).trim() || null;
        strongholds.push({ id, name, level, desc: str(n?.desc), parent });
    });
    const byId = new Map(strongholds.map(n => [n.id, n]));
    for (const n of strongholds) {
        if (n.parent && !byId.has(n.parent)) err(`strongholds`, 'shParentMissing', { name: n.name, parent: n.parent });
    }
    // 环检测
    for (const n of strongholds) {
        const seen = new Set([n.id]);
        let cur = n.parent ? byId.get(n.parent) : null;
        while (cur) {
            if (seen.has(cur.id)) { err('strongholds', 'shCycle', { name: n.name }); break; }
            seen.add(cur.id);
            cur = cur.parent ? byId.get(cur.parent) : null;
        }
    }
    // 同父节点下重名：现有合并按 名称+父节点 识别
    const siblingKeys = new Set();
    for (const n of strongholds) {
        const k = `${n.parent || ''}\0${n.name}`;
        if (siblingKeys.has(k)) err('strongholds', 'shSiblingDuplicate', { name: n.name });
        siblingKeys.add(k);
    }

    if (!bars.length && !skills.length && !items.length && !strongholds.length) err('', 'profileEmpty');

    const normalized = {
        schema: PB_SCHEMA,
        id: str(profile.id) || newId('pp_'),
        revision: parseNonNegInt(profile.revision) ?? 0,
        enabled: !!profile.enabled,
        personaKey: str(profile.personaKey),
        nameHint: str(profile.nameHint),
        bars, skills,
        items: items.map(({ fullName, ...rest }) => rest),
        strongholds,
        updatedAt: str(profile.updatedAt),
    };
    return { ok: errors.length === 0, errors, warnings, normalized };
}

/** 模板 → 冻结基线（不经过 skill:…|… 字符串协议，避免描述中的 | = @ 被误解析） */
export function buildBaseline(normalized, owner) {
    return {
        bars: normalized.bars.map(b => ({ ...b })),
        skills: normalized.skills.map(s => ({ ...s })),
        items: normalized.items.map(it => ({
            name: composeItemName(it.name, it.quantity, it.unit),
            icon: it.icon || '',
            holder: it.holder || owner,
            location: it.location || '',
            description: it.description || '',
            importance: it.importance || '',
        })),
        strongholds: normalized.strongholds.map(n => ({ ...n })),
    };
}

/** 本聊天的属性条定义快照（显示名/颜色/说明），优先于全局 rpgBarConfig */
export function barDefsFromBaseline(baseline) {
    return (baseline?.bars || []).map(b => ({
        key: b.key, name: b.name, color: b.color || '', desc: b.desc || '',
        min: 0, max: b.max, defaultMax: b.max, required: false,
    }));
}

/**
 * 创建开局基线记录（标记与数据同一对象，不可能出现「有标记无数据」）
 */
export function createBootstrapRecord({ normalized, personaKey, owner, chatKey, status = PB_STATUS.APPLIED, baseline = null }) {
    const base = baseline || buildBaseline(normalized, owner);
    return {
        v: PB_SCHEMA,
        status,
        personaKey: str(personaKey),
        owner: str(owner),
        profileId: normalized?.id || '',
        revision: normalized?.revision ?? 0,
        commitId: newId('pbc_'),
        chatKey: str(chatKey),
        at: new Date().toISOString(),
        boundary: 'pre-story',
        baseline: base,
        barDefs: barDefsFromBaseline(base),
        repairs: [],
    };
}

export function isRecordActive(record) {
    return !!record && typeof record === 'object' && record.status !== PB_STATUS.CLEARED;
}

/**
 * 折叠步骤：按「应用位置」分组。after=-1 表示在任何楼层之前（开局基线），
 * after=n 表示在楼层 n 之后（旧聊天补录）。位置超出现有楼层时归到最后一条之后。
 * @returns {Map<number, {rpgChanges:object, items:object[], strongholds:object[], kind:string}[]>}
 */
export function baselineSteps(record, chatLength) {
    const steps = new Map();
    if (!isRecordActive(record)) return steps;
    const owner = record.owner || '';
    const push = (after, entry, kind) => {
        if (!entry) return;
        const rpgChanges = { bars: {}, skills: [], status: {} };
        const addOwner = (who, bars, skills) => {
            for (const b of bars || []) {
                if (!rpgChanges.bars[who]) rpgChanges.bars[who] = {};
                rpgChanges.bars[who][b.key] = b.name ? [b.current, b.max, b.name] : [b.current, b.max];
            }
            for (const s of skills || []) rpgChanges.skills.push({ owner: who, name: s.name, level: s.level || '', desc: s.desc || '' });
        };
        addOwner(owner, entry.bars, entry.skills);
        for (const [who, data] of Object.entries(entry.extraOwners || {})) addOwner(who, data.bars, data.skills);
        for (const [who, effects] of Object.entries(entry.status || {})) {
            if (Array.isArray(effects) && effects.length) rpgChanges.status[who] = [...effects];
        }
        const at = Math.min(after, Math.max(-1, chatLength - 1));
        if (!steps.has(at)) steps.set(at, []);
        steps.get(at).push({ kind, rpgChanges, items: entry.items || [], strongholds: entry.strongholds || [] });
    };
    if (record.baseline) push(-1, record.baseline, 'baseline');
    for (const r of record.repairs || []) {
        const after = Number.isInteger(r.afterIndex) ? r.afterIndex : chatLength - 1;
        push(after, r, 'repair');
    }
    return steps;
}

/** 物品基线：同基本名已存在（例如补录前已被别的途径登记）则不覆盖 */
export function applyBaselineItems(stateItems, items) {
    for (const it of items || []) {
        const base = getItemBaseName(it.name).toLowerCase();
        const exists = Object.keys(stateItems).some(n => getItemBaseName(n).toLowerCase() === base);
        if (exists) continue;
        const { name, ...info } = it;
        stateItems[name] = { ...info };
    }
}

/** 据点基线：跳过已存在（同 id 或 同名+同父）与用户已删除的节点 */
export function applyBaselineStrongholds(nodes, baselineNodes, deleted = []) {
    const idMap = new Map();
    for (const n of baselineNodes || []) {
        const parentId = n.parent ? (idMap.get(n.parent) || n.parent) : null;
        const parentName = parentId ? (nodes.find(x => x.id === parentId)?.name || null) : null;
        if (deleted.some(d => d.name === n.name && (d.parent || null) === parentName)) continue;
        const existing = nodes.find(x => x.id === n.id) || nodes.find(x => x.name === n.name && (x.parent || null) === parentId);
        if (existing) { idMap.set(n.id, existing.id); continue; }
        nodes.push({ id: n.id, name: n.name, level: n.level ?? null, desc: n.desc || '', parent: parentId });
        idMap.set(n.id, n.id);
    }
}

/**
 * 是否为可自动初始化的新开局。保守判定：
 *  - 已有记录（任何状态）→ 否
 *  - 第一条 USER 消息之后出现任何非 USER 楼层（已有剧情）→ 否
 * 开场白（任意数量、可为空、可有多个 swipe）位于第一条 USER 之前，不影响判定。
 */
export function assessFreshChat(chat, record) {
    if (record) return { fresh: false, reason: 'hasRecord' };
    let seenUser = false;
    for (const m of chat || []) {
        if (!m) continue;
        if (m.is_user) { seenUser = true; continue; }
        if (seenUser) return { fresh: false, reason: 'hasStory' };
    }
    return { fresh: true, reason: '' };
}

/** 只有真正的剧情生成才会触发自动初始化 */
export function isNarrativeGeneration(type, dryRun) {
    if (dryRun) return false;
    const t = type || 'normal';
    return t === 'normal' || t === 'regenerate' || t === 'swipe' || t === 'continue';
}

/**
 * 旧聊天补录计划。默认全部不勾选；只有「确实缺失」的条目可选。
 * @param {object} normalized 已校验模板
 * @param {string} owner 当前聊天的玩家名
 * @param {object} ctx {items: 当前物品, rpg: 当前 RPG 快照, removedItemBases:Set, removedSkills:Set, deletedStrongholds:[]}
 */
export function planRepair(normalized, owner, ctx) {
    const rows = [];
    const items = ctx.items || {};
    const rpg = ctx.rpg || {};
    const ownerBars = rpg.bars?.[owner] || {};
    for (const b of normalized.bars) {
        rows.push({ kind: 'bar', key: `bar:${b.key}`, label: `${b.name} ${b.current}/${b.max}`,
            status: ownerBars[b.key] ? 'present' : 'missing',
            detail: ownerBars[b.key] ? `${ownerBars[b.key][0]}/${ownerBars[b.key][1]}` : '', data: b });
    }
    const ownerSkills = rpg.skills?.[owner] || [];
    for (const s of normalized.skills) {
        let status = 'missing';
        if (ownerSkills.some(x => x.name === s.name)) status = 'present';
        else if (ctx.removedSkills?.has(s.name)) status = 'removed';
        rows.push({ kind: 'skill', key: `skill:${s.name}`, label: s.name, status, data: s });
    }
    for (const it of normalized.items) {
        const base = it.name.toLowerCase();
        const existing = Object.entries(items).find(([n]) => getItemBaseName(n).toLowerCase() === base);
        let status = 'missing';
        let detail = '';
        if (existing) {
            const holder = existing[1]?.holder || '';
            const wanted = it.holder || owner;
            status = holder && holder !== wanted ? 'conflict' : 'present';
            detail = `${existing[0]}${holder ? ` = ${holder}` : ''}`;
        } else if (ctx.removedItemBases?.has(base)) status = 'removed';
        rows.push({ kind: 'item', key: `item:${it.name}`, label: composeItemName(it.name, it.quantity, it.unit), status, detail, data: it });
    }
    const nodes = rpg.strongholds || [];
    const byId = new Map(normalized.strongholds.map(n => [n.id, n]));
    for (const n of normalized.strongholds) {
        const parentName = n.parent ? byId.get(n.parent)?.name || null : null;
        const present = nodes.some(x => x.name === n.name && ((x.parent ? nodes.find(y => y.id === x.parent)?.name : null) || null) === parentName);
        let status = present ? 'present' : 'missing';
        if (!present && (ctx.deletedStrongholds || []).some(d => d.name === n.name && (d.parent || null) === parentName)) status = 'removed';
        rows.push({ kind: 'stronghold', key: `sh:${n.id}`, label: parentName ? `${parentName} > ${n.name}` : n.name, status, data: n });
    }
    return rows;
}

/** 由用户勾选的补录行生成补录条目（应用在当前边界 afterIndex 之后） */
export function buildRepairEntry(rows, selectedKeys, owner, afterIndex) {
    const sel = new Set(selectedKeys);
    const picked = rows.filter(r => sel.has(r.key) && r.status === 'missing');
    const entry = { commitId: newId('pbr_'), at: new Date().toISOString(), afterIndex, bars: [], skills: [], items: [], strongholds: [] };
    for (const r of picked) {
        if (r.kind === 'bar') entry.bars.push({ ...r.data });
        else if (r.kind === 'skill') entry.skills.push({ ...r.data });
        else if (r.kind === 'item') {
            const it = r.data;
            entry.items.push({ name: composeItemName(it.name, it.quantity, it.unit), icon: it.icon || '', holder: it.holder || owner,
                location: it.location || '', description: it.description || '', importance: it.importance || '' });
        } else if (r.kind === 'stronghold') entry.strongholds.push({ ...r.data });
    }
    // 子据点的父节点必须已存在或同时补录
    const shIds = new Set(entry.strongholds.map(n => n.id));
    const presentSh = new Set(rows.filter(r => r.kind === 'stronghold' && r.status === 'present').map(r => r.data.id));
    const orphan = entry.strongholds.find(n => n.parent && !shIds.has(n.parent) && !presentSh.has(n.parent));
    return { entry, picked: picked.length, error: orphan ? { code: 'shParentNotSelected', params: { name: orphan.name } } : null };
}

/** 模板导出（不含运行时战役数值、不含任何 API 凭据） */
export function exportProfileJson(normalized) {
    const { schema, bars, skills, items, strongholds, nameHint } = normalized;
    return JSON.stringify({ horaePersonaProfile: PB_SCHEMA, schema, nameHint, bars, skills, items, strongholds }, null, 2);
}

/** 模板导入：返回待校验的模板草稿（保留目标 Persona 绑定、id 与修订号由调用方决定） */
export function parseProfileJson(text) {
    let obj;
    try { obj = JSON.parse(text); } catch { return { ok: false, code: 'importNotJson' }; }
    if (!obj || typeof obj !== 'object' || (obj.horaePersonaProfile === undefined && obj.schema === undefined)) {
        return { ok: false, code: 'importNotProfile' };
    }
    if ((parseNonNegInt(obj.schema ?? obj.horaePersonaProfile) ?? 0) > PB_SCHEMA) return { ok: false, code: 'importNewerSchema' };
    return {
        ok: true,
        draft: {
            bars: Array.isArray(obj.bars) ? obj.bars : [],
            skills: Array.isArray(obj.skills) ? obj.skills : [],
            items: Array.isArray(obj.items) ? obj.items : [],
            strongholds: Array.isArray(obj.strongholds) ? obj.strongholds : [],
        },
    };
}

/** 新聊天/继承：由某一时刻的有效状态生成继承基线（carryover 用） */
export function baselineFromState({ items, rpg, owner }) {
    const baseline = { bars: [], skills: [], items: [], strongholds: [], extraOwners: {} };
    for (const [name, info] of Object.entries(items || {})) {
        baseline.items.push({ name, icon: info.icon || '', holder: info.holder || '', location: info.location || '',
            description: info.description || '', importance: info.importance || '' });
    }
    // 继承基线保留所有角色（不只是玩家）的属性条与技能
    for (const [who, bars] of Object.entries(rpg?.bars || {})) {
        for (const [key, val] of Object.entries(bars || {})) {
            if (!Array.isArray(val)) continue;
            const entry = { key, name: val[2] || '', current: val[0], max: val[1], desc: '', color: '' };
            if (who === owner) baseline.bars.push(entry);
            else (baseline.extraOwners[who] ||= { bars: [], skills: [] }).bars.push(entry);
        }
    }
    for (const [who, skills] of Object.entries(rpg?.skills || {})) {
        for (const s of skills || []) {
            const entry = { name: s.name, level: s.level || '', desc: s.desc || '' };
            if (who === owner) baseline.skills.push(entry);
            else (baseline.extraOwners[who] ||= { bars: [], skills: [] }).skills.push(entry);
        }
    }
    baseline.status = {};
    for (const [who, effects] of Object.entries(rpg?.status || {})) {
        if (Array.isArray(effects) && effects.length) baseline.status[who] = [...effects];
    }
    baseline.strongholds = (rpg?.strongholds || []).map(n => ({ id: n.id, name: n.name, level: n.level ?? null, desc: n.desc || '', parent: n.parent || null }));
    return baseline;
}
