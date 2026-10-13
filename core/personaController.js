/**
 * Horae - Persona 开局状态：生命周期、状态面板与编辑器
 *
 * 生命周期（ST 1.19 已核实）：
 *  - 自动初始化挂在 GENERATION_AFTER_COMMANDS（Generate 内 await；带 type 与 dryRun；
 *    早于提示词组装与 CHAT_COMPLETION_PROMPT_READY 中 Horae 的状态快照）。
 *  - generateRaw（Horae 的后台分析 / 摘要 / Query 重写）不触发该事件；quiet / impersonate / dryRun 显式排除。
 *  - 基线与「已初始化」标记是同一个对象，写入 chat_metadata 后经 saveMetadata()（= saveChatConditional）持久化。
 *  - 预检失败时调用 ST 的 stopGeneration() 取消本次生成，不带着半套状态发送。
 */

import {
    PB_SCHEMA, PB_META_KEY, PB_STATUS,
    createEmptyProfile, presetBars, validateProfile, createBootstrapRecord,
    assessFreshChat, isNarrativeGeneration, planRepair, buildRepairEntry, barDefsFromBaseline,
    exportProfileJson, parseProfileJson, baselineFromState, isRecordActive, composeItemName,
} from './personaBootstrap.js';

/**
 * @param {object} d 依赖注入
 *  getContext, settings, saveSettings, horaeManager, t, showToast, escapeHtml, isLightMode,
 *  preventModalBubble, refreshAllDisplays, onSettingsChanged, stopGeneration, chatKey,
 *  getActivePersonaKey, getPersonaName, listPersonas, getPersonaAvatarUrl, isMetadataMode
 */
export function createPersonaController(d) {
    const inflight = new Map();   // chatKey → Promise（同一聊天的初始化串行化）
    const runtime = new Map();    // chatKey → {state, reason}（仅内存：失败/不符合条件的最近结果）

    const tt = (key, vars) => {
        const v = d.t(key, vars);
        return v === key ? key.split('.').pop() : v;
    };
    const esc = (s) => d.escapeHtml(String(s ?? ''));

    // ---------------- 模板存储 ----------------
    function store() {
        const s = d.getSettings();
        if (!s.personaProfiles || typeof s.personaProfiles !== 'object') s.personaProfiles = { schema: PB_SCHEMA, profiles: {} };
        if (!s.personaProfiles.profiles || typeof s.personaProfiles.profiles !== 'object') s.personaProfiles.profiles = {};
        return s.personaProfiles;
    }
    function getProfile(personaKey) {
        if (!personaKey) return null;
        const p = store().profiles[personaKey];
        return p && typeof p === 'object' ? p : null;
    }
    function saveProfile(personaKey, draft) {
        const old = getProfile(personaKey);
        const v = validateProfile({ ...draft, id: old?.id || draft.id, revision: old?.revision || 0 });
        if (!v.ok) return v;
        const normalized = {
            ...v.normalized,
            id: old?.id || v.normalized.id,
            revision: (old?.revision || 0) + 1,
            personaKey,
            nameHint: d.getPersonaName(personaKey) || draft.nameHint || '',
            updatedAt: new Date().toISOString(),
        };
        // 每个 Persona 独立对象，避免复制/同名共享同一可变模板
        store().profiles[personaKey] = JSON.parse(JSON.stringify(normalized));
        d.saveSettings();
        return { ...v, normalized };
    }

    // ---------------- 前置开关 ----------------
    function prerequisites(normalized) {
        const s = d.getSettings();
        const rows = [{ key: 'injectContext', ok: s.injectContext !== false && s.enabled !== false }];
        const needRpg = normalized.bars.length || normalized.skills.length || normalized.strongholds.length;
        if (needRpg) rows.push({ key: 'rpgMode', ok: !!s.rpgMode });
        if (normalized.bars.length) rows.push({ key: 'sendRpgBars', ok: s.sendRpgBars !== false });
        if (normalized.skills.length) rows.push({ key: 'sendRpgSkills', ok: s.sendRpgSkills !== false });
        if (normalized.strongholds.length) rows.push({ key: 'sendRpgStronghold', ok: !!s.sendRpgStronghold });
        if (normalized.items.length) rows.push({ key: 'sendItems', ok: s.sendItems !== false });
        return rows;
    }
    function enablePrerequisites(normalized) {
        const s = d.getSettings();
        for (const r of prerequisites(normalized)) {
            if (r.ok) continue;
            if (r.key === 'injectContext') { s.injectContext = true; s.enabled = true; }
            else s[r.key] = true;
        }
        d.saveSettings();
        d.onSettingsChanged?.();
    }

    // ---------------- 聊天记录 ----------------
    function getRecord() {
        return d.getContext()?.chatMetadata?.[PB_META_KEY] || null;
    }

    /** 让 chat[0] 上的 RPG 聚合与基线一致（聚合只是缓存，权威来源是基线 + 楼层增量） */
    function ensureAggregate() {
        const hm = d.horaeManager;
        const chat = hm.getChat();
        if (!chat?.length) return false;
        const rec = getRecord();
        const mark = isRecordActive(rec) ? `${rec.commitId}:${(rec.repairs || []).length}` : '';
        const cur = chat[0]?.horae_meta?.rpg?._baselineMark || '';
        if (mark === cur) return false;
        hm.rebuildRpgData();
        return true;
    }

    function chatStatus() {
        const ctx = d.getContext();
        const key = d.chatKey();
        const activeKey = d.getActivePersonaKey();
        const rec = getRecord();
        const profile = getProfile(activeKey);
        const base = { activeKey, activeName: d.getPersonaName(activeKey) || ctx?.name1 || '', profile, record: rec, mismatch: false };
        if (!ctx?.chatId && !ctx?.getCurrentChatId?.()) return { ...base, state: 'noChat' };
        if (rec) {
            const mismatch = !!rec.personaKey && rec.personaKey !== activeKey;
            const state = rec.status === PB_STATUS.INHERITED ? 'inherited'
                : rec.status === PB_STATUS.REPAIRED ? 'repaired'
                    : rec.status === PB_STATUS.CLEARED ? 'cleared' : 'initialized';
            return { ...base, state, mismatch };
        }
        const rt = runtime.get(key);
        if (!profile) return { ...base, state: 'noProfile' };
        if (!profile.enabled) return { ...base, state: 'disabled' };
        const v = validateProfile(profile);
        if (!v.ok) return { ...base, state: 'invalid', errors: v.errors };
        const missing = prerequisites(v.normalized).filter(r => !r.ok);
        if (missing.length) return { ...base, state: 'prereqMissing', missing };
        if (rt?.state === 'failed') return { ...base, state: 'failed', reason: rt.reason };
        const fresh = assessFreshChat(d.horaeManager.getChat(), null);
        return { ...base, state: fresh.fresh ? 'ready' : 'notEligible' };
    }

    function fail(key, reason, abort) {
        runtime.set(key, { state: 'failed', reason });
        d.showToast(`${tt('persona.toast.initFailed')}: ${reason}`, 'error');
        if (abort) {
            try { d.stopGeneration?.(); } catch (e) { console.warn('[Horae][Persona] stopGeneration 失败:', e); }
        }
        renderStatus();
        return { ok: false, reason };
    }

    /**
     * 提交开局基线。所有校验在任何写入之前完成；写入前再次核对聊天与 Persona 身份。
     * @param {{abortOnFail?:boolean, reason?:string, allowCleared?:boolean}} opts
     */
    async function commitFromTemplate(opts = {}) {
        const ctx = d.getContext();
        const key = d.chatKey();
        const meta = ctx.chatMetadata;
        const personaKey = d.getActivePersonaKey();
        const owner = String(ctx.name1 || '').trim();
        const existing = meta?.[PB_META_KEY];
        if (existing && !(opts.allowCleared && existing.status === PB_STATUS.CLEARED)) return { ok: true, reused: true, record: existing };

        const profile = getProfile(personaKey);
        if (!profile) return fail(key, tt('persona.reason.noProfile'), opts.abortOnFail);
        const v = validateProfile(profile);
        if (!v.ok) return fail(key, tt('persona.reason.invalid', { n: v.errors.length }), opts.abortOnFail);
        const missing = prerequisites(v.normalized).filter(r => !r.ok);
        if (missing.length) return fail(key, `${tt('persona.reason.prereq')}: ${missing.map(m => tt(`persona.prereq.${m.key}`)).join(', ')}`, opts.abortOnFail);
        if (!personaKey) return fail(key, tt('persona.reason.noPersona'), opts.abortOnFail);
        if (!owner || /\{\{\s*user\s*\}\}/i.test(owner) || owner === String(ctx.name2 || '')) {
            return fail(key, tt('persona.reason.noOwner'), opts.abortOnFail);
        }

        const record = createBootstrapRecord({ normalized: v.normalized, personaKey, owner, chatKey: key });
        // 再次核对：期间若切换了聊天或 Persona，绝不写入
        const ctx2 = d.getContext();
        if (d.chatKey() !== key || ctx2.chatMetadata !== meta || d.getActivePersonaKey() !== personaKey) {
            return fail(key, tt('persona.reason.chatChanged'), opts.abortOnFail);
        }
        meta[PB_META_KEY] = record;
        try {
            await ctx2.saveMetadata();
        } catch (e) {
            if (meta[PB_META_KEY] === record) delete meta[PB_META_KEY];
            return fail(key, `${tt('persona.reason.saveFailed')}: ${e?.message || e}`, opts.abortOnFail);
        }
        runtime.delete(key);
        ensureAggregate();
        console.log(`[Horae][Persona] 开局基线已提交: ${owner} (${personaKey}) rev ${record.revision}, ${record.commitId}`);
        d.refreshAllDisplays();
        renderStatus();
        return { ok: true, record };
    }

    /** 生成前预检：仅对真正新开局 + 已启用模板生效 */
    async function preflight(type, dryRun) {
        if (!d.getSettings().enabled) return;
        if (!isNarrativeGeneration(type, dryRun)) return;
        const ctx = d.getContext();
        if (!ctx?.chatMetadata) return;
        if (ctx.chatMetadata[PB_META_KEY]) { ensureAggregate(); return; }
        const profile = getProfile(d.getActivePersonaKey());
        if (!profile?.enabled) return;
        const key = d.chatKey();
        const fresh = assessFreshChat(d.horaeManager.getChat(), null);
        if (!fresh.fresh) {
            runtime.set(key, { state: 'notEligible', reason: fresh.reason });
            return;
        }
        if (inflight.has(key)) { await inflight.get(key); return; }
        const p = commitFromTemplate({ abortOnFail: true }).finally(() => inflight.delete(key));
        inflight.set(key, p);
        await p;
    }

    /** 手动「立即初始化」：新开局或用户清空后的显式重新初始化 */
    async function initializeNow() {
        const rec = getRecord();
        if (rec && rec.status !== PB_STATUS.CLEARED) { d.showToast(tt('persona.toast.alreadyInit'), 'info'); return; }
        if (!rec) {
            const fresh = assessFreshChat(d.horaeManager.getChat(), null);
            if (!fresh.fresh) { d.showToast(tt('persona.toast.notFresh'), 'warning'); return; }
        } else if (!confirm(tt('persona.confirm.reinit'))) return;
        const r = await commitFromTemplate({ allowCleared: true });
        if (r.ok) d.showToast(tt('persona.toast.initDone'), 'success');
    }

    // ---------------- 显式清空 / carryover ----------------
    /** clearAllData 之后调用：基线一并清除并记录 opt-out，避免下次发送自动重建 */
    function markCleared() {
        const meta = d.getContext()?.chatMetadata;
        if (!meta) return;
        const prev = meta[PB_META_KEY];
        if (!prev) {
            // 新开局清空后也不应在下次发送时立即自动套用模板
            const profile = getProfile(d.getActivePersonaKey());
            if (!profile?.enabled) return;
        }
        meta[PB_META_KEY] = {
            v: PB_SCHEMA, status: PB_STATUS.CLEARED, clearedAt: new Date().toISOString(),
            personaKey: prev?.personaKey || d.getActivePersonaKey() || '', owner: prev?.owner || '',
        };
    }

    /** carryover 前在源聊天调用：边界之前的有效状态作为目标聊天的继承基线 */
    function captureInheritedBaseline(sourceChatLength, carryStart) {
        const hm = d.horaeManager;
        const skip = Math.max(0, sourceChatLength - carryStart);
        const src = getRecord();
        const owner = (isRecordActive(src) && src.owner) || String(d.getContext().name1 || '');
        const state = hm.getLatestState(skip);
        const rpg = hm.getRpgStateAt(skip);
        const baseline = baselineFromState({ items: state.items, rpg, owner });
        const rec = createBootstrapRecord({ normalized: null, personaKey: (isRecordActive(src) && src.personaKey) || d.getActivePersonaKey(), owner, chatKey: '', status: PB_STATUS.INHERITED, baseline });
        rec.boundary = 'carryover';
        if (isRecordActive(src) && Array.isArray(src.barDefs)) {
            rec.barDefs = [...src.barDefs, ...rec.barDefs.filter(b => !src.barDefs.some(x => x.key === b.key))];
        }
        return rec;
    }

    /** carryover 目标聊天：写入继承基线，并移除 seed 中与之重复的物品/RPG 聚合（避免重复重放） */
    function applyInherited(targetMeta, seedMeta, rec) {
        rec.chatKey = d.chatKey();
        targetMeta[PB_META_KEY] = rec;
        if (seedMeta) {
            delete seedMeta.items;
            seedMeta.deletedItems = [];
            if (seedMeta.rpg) { seedMeta.rpg.bars = {}; seedMeta.rpg.status = {}; seedMeta.rpg.skills = {}; }
        }
    }

    // ---------------- 旧聊天补录 ----------------
    function repairContext(owner) {
        const hm = d.horaeManager;
        const chat = hm.getChat();
        const removedItemBases = new Set();
        const removedSkills = new Set();
        const zeroRe = /[\(（]0[^\)）]*[\)）]$/;
        const consumedRe = /[\(（](已消耗|已用完|已销毁|已銷毀|消耗殆尽|消耗殆盡|消耗|用尽|用盡|consumed|used\s*up|destroyed|depleted)[\)）]/i;
        const baseOf = (n) => String(n).replace(consumedRe, '').replace(/[\(（][\d][\d\.\/]*[a-zA-Z一-鿿]*[\)）]$/, '').trim().toLowerCase();
        for (const m of chat) {
            const meta = m?.horae_meta;
            if (!meta) continue;
            for (const n of meta.deletedItems || []) removedItemBases.add(baseOf(n));
            for (const n of Object.keys(meta.items || {})) {
                if (zeroRe.test(n) || consumedRe.test(n)) removedItemBases.add(baseOf(n));
            }
            for (const s of meta._rpgChanges?.removedSkills || []) {
                if (hm._resolveRpgOwner(s.owner) === owner) removedSkills.add(s.name);
            }
        }
        const cfgs = chat[0]?.horae_meta?._rpgConfigs || {};
        for (const s of cfgs._deletedSkills || []) if (s.owner === owner) removedSkills.add(s.name);
        return {
            items: hm.getLatestState().items,
            rpg: hm.getRpgStateAt(0),
            removedItemBases, removedSkills,
            deletedStrongholds: cfgs._deletedStrongholds || [],
        };
    }

    function repairOwner() {
        const rec = getRecord();
        return (isRecordActive(rec) && rec.owner) || String(d.getContext().name1 || '');
    }

    function buildRepairPlan() {
        const profile = getProfile(d.getActivePersonaKey());
        if (!profile) return { ok: false, code: 'noProfile' };
        const v = validateProfile(profile);
        if (!v.ok) return { ok: false, code: 'invalid', errors: v.errors };
        const owner = repairOwner();
        return { ok: true, owner, normalized: v.normalized, rows: planRepair(v.normalized, owner, repairContext(owner)) };
    }

    async function applyRepair(plan, selectedKeys) {
        const chat = d.horaeManager.getChat();
        const ctx = d.getContext();
        const meta = ctx.chatMetadata;
        const { entry, picked, error } = buildRepairEntry(plan.rows, selectedKeys, plan.owner, chat.length - 1);
        if (error) { d.showToast(tt(`persona.err.${error.code}`, error.params), 'warning'); return false; }
        if (!picked) { d.showToast(tt('persona.toast.nothingSelected'), 'info'); return false; }
        const prev = meta[PB_META_KEY];
        let rec;
        if (isRecordActive(prev)) {
            rec = prev;
            rec.repairs = [...(rec.repairs || []), entry];
        } else {
            rec = {
                v: PB_SCHEMA, status: PB_STATUS.REPAIRED, personaKey: d.getActivePersonaKey(), owner: plan.owner,
                profileId: plan.normalized.id, revision: plan.normalized.revision, commitId: `pbc_repair_${entry.commitId}`,
                chatKey: d.chatKey(), at: entry.at, boundary: 'repair', baseline: null, barDefs: [], repairs: [entry],
            };
        }
        const defs = barDefsFromBaseline({ bars: entry.bars });
        rec.barDefs = [...(rec.barDefs || []), ...defs.filter(x => !(rec.barDefs || []).some(y => y.key === x.key))];
        meta[PB_META_KEY] = rec;
        ensureAggregate();
        await ctx.saveMetadata();
        d.refreshAllDisplays();
        renderStatus();
        d.showToast(tt('persona.toast.repairDone', { n: picked }), 'success');
        return true;
    }

    async function undoLastRepair() {
        const ctx = d.getContext();
        const meta = ctx.chatMetadata;
        const rec = meta?.[PB_META_KEY];
        if (!isRecordActive(rec) || !rec.repairs?.length) return;
        if (!confirm(tt('persona.confirm.undoRepair'))) return;
        const last = rec.repairs[rec.repairs.length - 1];
        rec.repairs = rec.repairs.slice(0, -1);
        // 补录据点会被 rebuild 同步进 _rpgConfigs，撤销时一并移除
        const ids = new Set((last.strongholds || []).map(n => n.id));
        const first = d.horaeManager.getChat()?.[0]?.horae_meta;
        if (ids.size && first) {
            if (first._rpgConfigs?.strongholds) first._rpgConfigs.strongholds = first._rpgConfigs.strongholds.filter(n => !ids.has(n.id));
            if (first.rpg?.strongholds) first.rpg.strongholds = first.rpg.strongholds.filter(n => !ids.has(n.id));
        }
        if (rec.status === PB_STATUS.REPAIRED && !rec.repairs.length) delete meta[PB_META_KEY];
        ensureAggregate();
        await ctx.saveMetadata();
        d.refreshAllDisplays();
        renderStatus();
    }

    // ---------------- 状态面板 ----------------
    function renderStatus() {
        if (typeof document === 'undefined') return;
        const hosts = document.querySelectorAll('.horae-persona-status-host');
        if (!hosts.length) return;
        let st;
        try { st = chatStatus(); } catch (e) { console.warn('[Horae][Persona] 状态计算失败:', e); return; }
        const rec = st.record;
        const lines = [];
        const label = tt(`persona.state.${st.state}`);
        let detail = '';
        if (st.state === 'initialized' || st.state === 'inherited' || st.state === 'repaired') {
            detail = tt('persona.detail.record', { owner: rec.owner || '?', rev: rec.revision ?? '-', at: (rec.at || '').slice(0, 16).replace('T', ' ') });
            if (rec.repairs?.length) detail += ` · ${tt('persona.detail.repairs', { n: rec.repairs.length })}`;
        } else if (st.state === 'failed') detail = st.reason || '';
        else if (st.state === 'prereqMissing') detail = st.missing.map(m => tt(`persona.prereq.${m.key}`)).join(', ');
        else if (st.state === 'invalid') detail = tt('persona.reason.invalid', { n: st.errors.length });
        else if (st.state === 'notEligible') detail = tt('persona.detail.notEligible');
        lines.push(`<div class="horae-persona-status-line" data-state="${st.state}"><b>${esc(label)}</b>${detail ? ` <span class="horae-persona-status-detail">${esc(detail)}</span>` : ''}</div>`);
        if (st.mismatch) {
            lines.push(`<div class="horae-persona-mismatch"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(tt('persona.detail.mismatch', { owner: rec.owner || '?', active: st.activeName || st.activeKey }))}</div>`);
        }
        const persona = `<span class="horae-persona-who">${esc(st.activeName || st.activeKey || '-')}</span>`;
        const canInit = (!rec && st.state === 'ready') || st.state === 'cleared';
        const canRepair = st.state !== 'noChat' && !!st.profile && st.state !== 'ready';
        const canUndo = isRecordActive(rec) && rec.repairs?.length > 0;
        const html = `
            <div class="horae-persona-status">
                <div class="horae-persona-status-head"><i class="fa-solid fa-id-card"></i> ${esc(tt('persona.title'))} · ${persona}</div>
                ${lines.join('')}
                <div class="horae-persona-status-actions">
                    <button class="horae-btn horae-persona-btn-edit"><i class="fa-solid fa-pen"></i> ${esc(tt('persona.btn.edit'))}</button>
                    ${canInit ? `<button class="horae-btn horae-persona-btn-init"><i class="fa-solid fa-play"></i> ${esc(tt('persona.btn.initNow'))}</button>` : ''}
                    ${canRepair ? `<button class="horae-btn horae-persona-btn-repair"><i class="fa-solid fa-kit-medical"></i> ${esc(tt('persona.btn.repair'))}</button>` : ''}
                    ${canUndo ? `<button class="horae-btn horae-persona-btn-undo"><i class="fa-solid fa-rotate-left"></i> ${esc(tt('persona.btn.undoRepair'))}</button>` : ''}
                </div>
            </div>`;
        hosts.forEach(h => {
            h.innerHTML = html;
            h.querySelector('.horae-persona-btn-edit')?.addEventListener('click', () => openEditor());
            h.querySelector('.horae-persona-btn-init')?.addEventListener('click', () => initializeNow());
            h.querySelector('.horae-persona-btn-repair')?.addEventListener('click', () => openRepairModal());
            h.querySelector('.horae-persona-btn-undo')?.addEventListener('click', () => undoLastRepair());
        });
    }

    // ---------------- 编辑器 ----------------
    function closeModal() {
        document.getElementById('horae-persona-modal')?.remove();
    }

    function errText(e) {
        const msg = tt(`persona.err.${e.code}`, e.params || {});
        return e.path ? `${e.path}: ${msg}` : msg;
    }

    function openEditor(personaKey) {
        closeModal();
        const activeKey = d.getActivePersonaKey();
        let key = personaKey || activeKey;
        const existing = getProfile(key);
        let draft = JSON.parse(JSON.stringify(existing || createEmptyProfile(key, d.getPersonaName(key))));

        const optionHtml = () => d.listPersonas().map(p =>
            `<option value="${esc(p.key)}" ${p.key === key ? 'selected' : ''}>${p.key === activeKey ? '★ ' : ''}${esc(p.name || p.key)}${getProfile(p.key) ? ' ✓' : ''}</option>`).join('');

        const barRow = (b, i) => `
            <div class="horae-pp-row" data-sec="bars" data-i="${i}">
                <input data-f="key" value="${esc(b.key)}" maxlength="10" placeholder="key (hp)" class="horae-pp-key" />
                <input data-f="name" value="${esc(b.name)}" placeholder="${esc(tt('persona.f.barName'))}" class="horae-pp-name" />
                <input data-f="current" value="${esc(b.current ?? '')}" inputmode="numeric" placeholder="${esc(tt('persona.f.current'))}" class="horae-pp-num" />
                <span>/</span>
                <input data-f="max" value="${esc(b.max ?? '')}" inputmode="numeric" placeholder="${esc(tt('persona.f.max'))}" class="horae-pp-num" />
                <input data-f="color" type="color" value="${esc(b.color || '#6366f1')}" />
                <input data-f="desc" value="${esc(b.desc || '')}" placeholder="${esc(tt('persona.f.desc'))}" class="horae-pp-grow" />
                <button class="horae-pp-del" title="${esc(tt('persona.btn.remove'))}"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
        const skillRow = (s, i) => `
            <div class="horae-pp-row horae-pp-block" data-sec="skills" data-i="${i}">
                <div class="horae-pp-line">
                    <input data-f="name" value="${esc(s.name)}" placeholder="${esc(tt('persona.f.skillName'))}" class="horae-pp-grow" />
                    <input data-f="level" value="${esc(s.level || '')}" placeholder="${esc(tt('persona.f.level'))}" class="horae-pp-name" />
                    <button class="horae-pp-del" title="${esc(tt('persona.btn.remove'))}"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <textarea data-f="desc" rows="3" placeholder="${esc(tt('persona.f.fullDesc'))}">${esc(s.desc || '')}</textarea>
            </div>`;
        const itemRow = (it, i) => `
            <div class="horae-pp-row horae-pp-block" data-sec="items" data-i="${i}">
                <div class="horae-pp-line">
                    <input data-f="icon" value="${esc(it.icon || '')}" placeholder="🔑" class="horae-pp-icon" />
                    <input data-f="name" value="${esc(it.name)}" placeholder="${esc(tt('persona.f.itemName'))}" class="horae-pp-grow" />
                    <input data-f="quantity" value="${esc(it.quantity ?? 1)}" inputmode="numeric" placeholder="1" class="horae-pp-num" title="${esc(tt('persona.f.quantity'))}" />
                    <input data-f="unit" value="${esc(it.unit || '')}" placeholder="${esc(tt('persona.f.unit'))}" class="horae-pp-unit" />
                    <select data-f="importance">
                        <option value="" ${!it.importance ? 'selected' : ''}>${esc(tt('persona.f.impNormal'))}</option>
                        <option value="!" ${it.importance === '!' ? 'selected' : ''}>${esc(tt('persona.f.impImportant'))}</option>
                        <option value="!!" ${it.importance === '!!' ? 'selected' : ''}>${esc(tt('persona.f.impCritical'))}</option>
                    </select>
                    <button class="horae-pp-del" title="${esc(tt('persona.btn.remove'))}"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="horae-pp-line">
                    <input data-f="holder" value="${esc(it.holder || '')}" placeholder="${esc(tt('persona.f.holder'))}" class="horae-pp-grow" />
                    <input data-f="location" value="${esc(it.location || '')}" placeholder="${esc(tt('persona.f.location'))}" class="horae-pp-grow" />
                </div>
                <textarea data-f="description" rows="3" placeholder="${esc(tt('persona.f.fullDesc'))}">${esc(it.description || '')}</textarea>
            </div>`;
        const shRow = (n, i, all) => `
            <div class="horae-pp-row horae-pp-block" data-sec="strongholds" data-i="${i}">
                <div class="horae-pp-line">
                    <input data-f="name" value="${esc(n.name)}" placeholder="${esc(tt('persona.f.shName'))}" class="horae-pp-grow" />
                    <select data-f="parent">
                        <option value="">${esc(tt('persona.f.noParent'))}</option>
                        ${all.filter((x, j) => j !== i && x.id).map(x => `<option value="${esc(x.id)}" ${n.parent === x.id ? 'selected' : ''}>${esc(x.name || x.id)}</option>`).join('')}
                    </select>
                    <input data-f="level" value="${esc(n.level ?? '')}" inputmode="numeric" placeholder="Lv" class="horae-pp-num" />
                    <input data-f="id" type="hidden" value="${esc(n.id || '')}" />
                    <button class="horae-pp-del" title="${esc(tt('persona.btn.remove'))}"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <textarea data-f="desc" rows="2" placeholder="${esc(tt('persona.f.fullDesc'))}">${esc(n.desc || '')}</textarea>
            </div>`;

        const sectionHtml = (sec, title, rows, extra = '') => `
            <details class="horae-pp-section" data-sec="${sec}" open>
                <summary>${esc(title)} <span class="horae-pp-count">(${rows.length})</span></summary>
                <div class="horae-pp-rows">${rows.join('')}</div>
                <div class="horae-pp-sec-actions">
                    <button class="horae-btn horae-pp-add" data-sec="${sec}"><i class="fa-solid fa-plus"></i> ${esc(tt('persona.btn.add'))}</button>
                    ${extra}
                </div>
            </details>`;

        const renderBody = () => {
            const st = chatStatus();
            const v = validateProfile(draft);
            const prereq = v.normalized ? prerequisites(v.normalized) : [];
            const avatar = d.getPersonaAvatarUrl(key);
            const body = document.getElementById('horae-pp-body');
            if (!body) return;
            body.innerHTML = `
                <div class="horae-pp-persona">
                    ${avatar ? `<img class="horae-pp-avatar" src="${esc(avatar)}" alt="" />` : ''}
                    <div class="horae-pp-persona-info">
                        <select id="horae-pp-persona-select">${optionHtml()}</select>
                        <div class="horae-pp-hint">${key === activeKey ? esc(tt('persona.hint.active')) : esc(tt('persona.hint.notActive'))} · <code>${esc(key || '-')}</code></div>
                    </div>
                </div>
                <label class="horae-pp-enable"><input type="checkbox" id="horae-pp-enabled" ${draft.enabled ? 'checked' : ''}/> ${esc(tt('persona.f.enabled'))}</label>
                <div class="horae-pp-hint">${esc(tt('persona.hint.futureOnly'))}</div>
                <div class="horae-pp-hint">${esc(tt('persona.hint.chatStatus'))}: <b>${esc(tt(`persona.state.${st.state}`))}</b></div>
                ${prereq.length ? `<div class="horae-pp-prereq">${prereq.map(r => `<span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'} ${esc(tt(`persona.prereq.${r.key}`))}</span>`).join(' ')}
                    ${prereq.some(r => !r.ok) ? `<button class="horae-btn" id="horae-pp-enable-prereq"><i class="fa-solid fa-toggle-on"></i> ${esc(tt('persona.btn.enablePrereq'))}</button>` : ''}</div>` : ''}
                ${sectionHtml('bars', tt('persona.sec.bars'), draft.bars.map(barRow), `<button class="horae-btn" id="horae-pp-preset"><i class="fa-solid fa-heart-pulse"></i> ${esc(tt('persona.btn.preset'))}</button>`)}
                ${sectionHtml('skills', tt('persona.sec.skills'), draft.skills.map(skillRow))}
                ${sectionHtml('items', tt('persona.sec.items'), draft.items.map(itemRow))}
                ${sectionHtml('strongholds', tt('persona.sec.strongholds'), draft.strongholds.map((n, i) => shRow(n, i, draft.strongholds)))}
                <div id="horae-pp-result" class="horae-pp-result"></div>`;
            bindBody();
        };

        const collect = () => {
            const body = document.getElementById('horae-pp-body');
            if (!body) return draft;
            const next = { ...draft, bars: [], skills: [], items: [], strongholds: [] };
            next.enabled = !!body.querySelector('#horae-pp-enabled')?.checked;
            body.querySelectorAll('.horae-pp-row').forEach(row => {
                const sec = row.dataset.sec;
                const obj = {};
                row.querySelectorAll('[data-f]').forEach(el => { obj[el.dataset.f] = el.value; });
                next[sec].push(obj);
            });
            // 据点：为新节点分配稳定 id，供父节点选择
            next.strongholds.forEach((n, i) => { if (!n.id) n.id = `shb_${Date.now().toString(36)}${i}`; });
            return next;
        };

        const showResult = (v, savedMsg) => {
            const el = document.getElementById('horae-pp-result');
            if (!el) return;
            if (v.ok) {
                const n = v.normalized;
                const owner = d.getContext().name1 || '?';
                const preview = [
                    ...n.bars.map(b => `${b.name}(${b.key}) ${b.current}/${b.max}`),
                    ...n.skills.map(s => `${tt('persona.sec.skills')}: ${s.name}${s.level ? ` ${s.level}` : ''} — ${s.desc.length} ${tt('persona.chars')}`),
                    ...n.items.map(it => `${tt('persona.sec.items')}: ${it.icon || ''}${composeItemName(it.name, it.quantity, it.unit)} = ${it.holder || owner}${it.location ? `@${it.location}` : ''}`),
                    ...n.strongholds.map(s => `${tt('persona.sec.strongholds')}: ${s.name}${s.parent ? ` ⊂ ${n.strongholds.find(x => x.id === s.parent)?.name}` : ''}`),
                ];
                el.innerHTML = `<div class="horae-pp-ok">${esc(savedMsg || tt('persona.toast.valid'))}</div>`
                    + (v.warnings.length ? `<ul class="horae-pp-warn">${v.warnings.map(w => `<li>${esc(errText(w))}</li>`).join('')}</ul>` : '')
                    + `<ul class="horae-pp-preview">${preview.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
            } else {
                el.innerHTML = `<ul class="horae-pp-errors">${v.errors.map(e => `<li>${esc(errText(e))}</li>`).join('')}</ul>`;
            }
        };

        const bindBody = () => {
            const body = document.getElementById('horae-pp-body');
            body.querySelector('#horae-pp-persona-select')?.addEventListener('change', (e) => {
                key = e.target.value;
                draft = JSON.parse(JSON.stringify(getProfile(key) || createEmptyProfile(key, d.getPersonaName(key))));
                renderBody();
            });
            body.querySelectorAll('.horae-pp-add').forEach(btn => btn.addEventListener('click', () => {
                draft = collect();
                const sec = btn.dataset.sec;
                if (sec === 'bars') draft.bars.push({ key: '', name: '', current: '', max: '', color: '#6366f1', desc: '' });
                if (sec === 'skills') draft.skills.push({ name: '', level: '', desc: '' });
                if (sec === 'items') draft.items.push({ name: '', quantity: 1, unit: '', holder: '', location: '', icon: '', importance: '', description: '' });
                if (sec === 'strongholds') draft.strongholds.push({ id: `shb_${Date.now().toString(36)}`, name: '', level: '', desc: '', parent: '' });
                renderBody();
            }));
            body.querySelectorAll('.horae-pp-del').forEach(btn => btn.addEventListener('click', () => {
                const row = btn.closest('.horae-pp-row');
                draft = collect();
                draft[row.dataset.sec].splice(Number(row.dataset.i), 1);
                renderBody();
            }));
            body.querySelector('#horae-pp-preset')?.addEventListener('click', () => {
                draft = collect();
                const keys = new Set(draft.bars.map(b => String(b.key).toLowerCase()));
                for (const b of presetBars()) if (!keys.has(b.key)) draft.bars.push(b);
                renderBody();
            });
            body.querySelector('#horae-pp-enable-prereq')?.addEventListener('click', () => {
                draft = collect();
                const v = validateProfile(draft);
                if (v.normalized) enablePrerequisites(v.normalized);
                renderBody();
            });
        };

        const html = `
            <div id="horae-persona-modal" class="horae-modal${d.isLightMode() ? ' horae-light' : ''}">
                <div class="horae-modal-content horae-pp-modal">
                    <div class="horae-modal-header"><i class="fa-solid fa-id-card"></i> ${esc(tt('persona.editorTitle'))}</div>
                    <div class="horae-modal-body" id="horae-pp-body"></div>
                    <div class="horae-modal-footer horae-pp-footer">
                        <button class="horae-btn" id="horae-pp-validate"><i class="fa-solid fa-list-check"></i> ${esc(tt('persona.btn.validate'))}</button>
                        <button class="horae-btn primary" id="horae-pp-save"><i class="fa-solid fa-check"></i> ${esc(tt('persona.btn.save'))}</button>
                        <button class="horae-btn" id="horae-pp-export" title="${esc(tt('persona.btn.export'))}"><i class="fa-solid fa-download"></i> ${esc(tt('persona.btn.export'))}</button>
                        <button class="horae-btn" id="horae-pp-import" title="${esc(tt('persona.btn.import'))}"><i class="fa-solid fa-upload"></i> ${esc(tt('persona.btn.import'))}</button>
                        <input type="file" id="horae-pp-import-file" accept=".json" style="display:none" />
                        <button class="horae-btn" id="horae-pp-close"><i class="fa-solid fa-xmark"></i> ${esc(tt('persona.btn.close'))}</button>
                    </div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        d.preventModalBubble?.();
        renderBody();

        const modal = document.getElementById('horae-persona-modal');
        modal.addEventListener('click', (e) => { if (e.target.id === 'horae-persona-modal') closeModal(); });
        modal.querySelector('#horae-pp-close').addEventListener('click', closeModal);
        modal.querySelector('#horae-pp-validate').addEventListener('click', () => { draft = collect(); showResult(validateProfile(draft)); });
        modal.querySelector('#horae-pp-save').addEventListener('click', () => {
            draft = collect();
            if (!key) { d.showToast(tt('persona.reason.noPersona'), 'error'); return; }
            const r = saveProfile(key, draft);
            if (!r.ok) { showResult(r); d.showToast(tt('persona.toast.saveInvalid'), 'error'); return; }
            draft = JSON.parse(JSON.stringify(getProfile(key)));
            renderBody();
            showResult(r, tt('persona.toast.saved', { rev: r.normalized.revision }));
            renderStatus();
        });
        modal.querySelector('#horae-pp-export').addEventListener('click', () => {
            draft = collect();
            const v = validateProfile(draft);
            if (!v.ok) { showResult(v); return; }
            const blob = new Blob([exportProfileJson(v.normalized)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `horae_persona_${(d.getPersonaName(key) || key || 'profile').replace(/[^\w一-鿿-]+/g, '_')}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
        const fileInput = modal.querySelector('#horae-pp-import-file');
        modal.querySelector('#horae-pp-import').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const f = fileInput.files?.[0];
            fileInput.value = '';
            if (!f) return;
            const r = parseProfileJson(await f.text());
            if (!r.ok) { d.showToast(tt(`persona.err.${r.code}`), 'error'); return; }
            draft = { ...collect(), ...r.draft };
            renderBody();
            showResult(validateProfile(draft));
            d.showToast(tt('persona.toast.imported'), 'info');
        });
    }

    function openRepairModal() {
        closeModal();
        const plan = buildRepairPlan();
        if (!plan.ok) {
            d.showToast(tt(plan.code === 'noProfile' ? 'persona.reason.noProfile' : 'persona.toast.saveInvalid'), 'warning');
            return;
        }
        const statusLabel = (s) => tt(`persona.repair.${s}`);
        const rows = plan.rows.map(r => `
            <label class="horae-pp-repair-row" data-status="${r.status}">
                <input type="checkbox" value="${esc(r.key)}" ${r.status === 'missing' ? '' : 'disabled'} />
                <span class="horae-pp-repair-kind">${esc(tt(`persona.kind.${r.kind}`))}</span>
                <span class="horae-pp-repair-label">${esc(r.label)}</span>
                <span class="horae-pp-repair-status">${esc(statusLabel(r.status))}${r.detail ? ` (${esc(r.detail)})` : ''}</span>
            </label>`).join('');
        const html = `
            <div id="horae-persona-modal" class="horae-modal${d.isLightMode() ? ' horae-light' : ''}">
                <div class="horae-modal-content horae-pp-modal">
                    <div class="horae-modal-header"><i class="fa-solid fa-kit-medical"></i> ${esc(tt('persona.repairTitle'))}</div>
                    <div class="horae-modal-body">
                        <div class="horae-pp-hint">${esc(tt('persona.hint.repair', { owner: plan.owner }))}</div>
                        <div class="horae-pp-repair-list">${rows}</div>
                    </div>
                    <div class="horae-modal-footer">
                        <button class="horae-btn primary" id="horae-pp-repair-apply"><i class="fa-solid fa-check"></i> ${esc(tt('persona.btn.applySelected'))}</button>
                        <button class="horae-btn" id="horae-pp-close"><i class="fa-solid fa-xmark"></i> ${esc(tt('persona.btn.close'))}</button>
                    </div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        d.preventModalBubble?.();
        const modal = document.getElementById('horae-persona-modal');
        modal.addEventListener('click', (e) => { if (e.target.id === 'horae-persona-modal') closeModal(); });
        modal.querySelector('#horae-pp-close').addEventListener('click', closeModal);
        modal.querySelector('#horae-pp-repair-apply').addEventListener('click', async () => {
            const keys = [...modal.querySelectorAll('.horae-pp-repair-list input:checked')].map(i => i.value);
            if (await applyRepair(plan, keys)) closeModal();
        });
    }

    return {
        getProfile, saveProfile, getRecord, prerequisites, enablePrerequisites,
        chatStatus, preflight, initializeNow, ensureAggregate, markCleared,
        captureInheritedBaseline, applyInherited,
        buildRepairPlan, applyRepair, undoLastRepair,
        renderStatus, openEditor, openRepairModal,
    };
}
