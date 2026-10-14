/**
 * Horae - 后台状态分析（Background / Metadata Only 模式）
 *
 * 职责：
 *  - 为「已完成的 AI 楼层」安排独立的后台分析任务（串行、按楼层顺序）
 *  - 以 chatKey + 消息对象 + swipe_id + 正文指纹 标识任务，提交前再次校验，丢弃过期结果
 *  - 严格解析辅助模型的私有输出（不做宽松解析）
 *  - 在 horae_meta._bg 中记录可校验的「已分析」标记（含无变化结果）
 *
 * 本模块不直接依赖 SillyTavern，所有副作用通过 deps 注入，便于单元测试。
 */

import { createEmptyMeta } from './horaeManager.js';

export const BG_MARKER_VERSION = 1;

export const BG_STATUS = Object.freeze({
    DONE: 'done',          // 已分析，有状态变化
    NO_CHANGE: 'nochange', // 已分析，无状态变化
    FAILED: 'failed',      // 分析失败，可重试
});

/** 32 位 FNV-1a，输出 `长度:哈希` 形式，足以区分同一楼层的不同版本 */
export function fingerprintText(text) {
    const s = String(text ?? '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${s.length}:${h.toString(16).padStart(8, '0')}`;
}

/** 楼层的 swipe 版本标识；无 swipe 的消息统一为 0 */
export function getSwipeId(message) {
    const id = message?.swipe_id;
    return typeof id === 'number' && Number.isFinite(id) ? id : 0;
}

/** 读取持久化的分析标记 */
export function getBgMarker(message) {
    const m = message?.horae_meta?._bg;
    return m && typeof m === 'object' ? m : null;
}

/** 当前正文是否已被成功分析（含「无变化」） */
export function isMessageAnalyzed(message) {
    const m = getBgMarker(message);
    if (!m) return false;
    if (m.status !== BG_STATUS.DONE && m.status !== BG_STATUS.NO_CHANGE) return false;
    return m.fp === fingerprintText(message?.mes);
}

const NO_CHANGE_RE = /<horae[_-]?nochange\s*\/?>|<horae[_-]?nochange>\s*<\/horae[_-]?nochange>/i;
const ANY_HORAE_BLOCK_RE = /<horae(?:event|rpg|table[:：][^>]*)?>[\s\S]*?<\/horae(?:event|rpg|table(?:[:：][^>]*)?)?>/i;

/** 解析结果里是否真的含有状态数据 */
export function hasMeaningfulParsed(parsed) {
    if (!parsed) return false;
    const nonEmptyObj = (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0;
    const nonEmptyArr = (a) => Array.isArray(a) && a.length > 0;
    if (parsed.timestamp?.story_date || parsed.timestamp?.story_time) return true;
    const sc = parsed.scene || {};
    if (sc.location || sc.atmosphere || sc.scene_desc || nonEmptyArr(sc.characters_present)) return true;
    if (nonEmptyObj(parsed.costumes) || nonEmptyObj(parsed.items) || nonEmptyArr(parsed.deletedItems)) return true;
    if (nonEmptyArr(parsed.events) || parsed.event) return true;
    if (nonEmptyObj(parsed.affection) || nonEmptyObj(parsed.npcs)) return true;
    if (nonEmptyArr(parsed.agenda) || nonEmptyArr(parsed.deletedAgenda)) return true;
    if (nonEmptyObj(parsed.mood) || nonEmptyArr(parsed.relationships)) return true;
    if (nonEmptyArr(parsed.tableUpdates)) return true;
    const r = parsed.rpg;
    if (r) {
        if (nonEmptyObj(r.bars) || nonEmptyObj(r.status) || nonEmptyArr(r.skills) || nonEmptyArr(r.removedSkills)) return true;
        if (nonEmptyObj(r.attributes) || nonEmptyObj(r.reputation) || nonEmptyArr(r.equipment) || nonEmptyArr(r.unequip)) return true;
        if (nonEmptyObj(r.levels) || nonEmptyObj(r.xp) || nonEmptyArr(r.currency) || nonEmptyArr(r.baseChanges)) return true;
    }
    return false;
}

// 主模型受旧卡/旧历史影响而在正文末尾写出的裸状态行（time:/costume:/npc:/event: …）
const STATE_DUMP_KEY_RE = /^\s*(?:[-*•·]\s*)?(?:time|date|location|atmosphere|scene_desc|characters|costume|item-|item!!|item!|item|event|affection|npc|agenda-|agenda|rel|mood|status|skill-|skill|equip|unequip|rep|level|xp|currency|attr|base)\s*[:：]/i;
const STATE_DUMP_BAR_RE = /^\s*[a-z]{1,10}\s*[:：][^=＝\n]{1,40}[=＝]\s*-?\d+(?:\.\d+)?\s*\/\s*\d+/i;
const STATE_DUMP_TAG_RE = /^\s*<\/?horae(?:event|rpg|table[:：]?[^>]*)?\s*\/?>\s*$|^\s*<horaenochange\s*\/?>\s*$/i;

export function isStateDumpLine(line) {
    return STATE_DUMP_KEY_RE.test(line) || STATE_DUMP_BAR_RE.test(line) || STATE_DUMP_TAG_RE.test(line);
}

/**
 * 拆出正文末尾连续的状态行块（至少 2 行，中间可夹空行/标签行）。只用于显示隐藏与发送前清理，不改 mes。
 * @returns {{prose:string, dump:string}} 无状态块时 dump 为 ''
 */
export function splitTrailingStateDump(text) {
    const src = String(text ?? '');
    const lines = src.split('\n');
    let start = lines.length;
    let count = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].replace(/\r$/, '');
        if (!line.trim()) { start = i; continue; }
        if (!isStateDumpLine(line)) break;
        if (!STATE_DUMP_TAG_RE.test(line)) count++;
        start = i;
    }
    if (count < 2) return { prose: src, dump: '' };
    return { prose: lines.slice(0, start).join('\n').replace(/\s+$/, ''), dump: lines.slice(start).join('\n').trim() };
}

/**
 * 严格解析辅助模型的私有响应
 * @returns {{kind:'changes', parsed:object} | {kind:'nochange'} | {kind:'invalid', reason:string}}
 */
export function parseBgResponse(raw, parseTag) {
    if (raw == null) return { kind: 'invalid', reason: 'empty response' };
    let text = String(raw);
    // 思维链不参与解析
    text = text.replace(/<think(?:ing)?[\s>][\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    if (!text) return { kind: 'invalid', reason: 'empty response' };

    const hasBlock = ANY_HORAE_BLOCK_RE.test(text);
    const hasNoChange = NO_CHANGE_RE.test(text);
    if (!hasBlock) {
        if (hasNoChange) return { kind: 'nochange' };
        return { kind: 'invalid', reason: 'no <horae>/<horaeevent>/<horaerpg>/<horaetable> block or <horaenochange/> marker' };
    }

    let parsed = null;
    try {
        parsed = parseTag(text);
    } catch (err) {
        return { kind: 'invalid', reason: `parse error: ${err?.message || err}` };
    }
    if (!parsed) return { kind: 'invalid', reason: 'unparseable tag content' };
    if (!hasMeaningfulParsed(parsed)) return { kind: 'nochange' };
    return { kind: 'changes', parsed };
}

/**
 * 楼层自身的状态增量字段（每次分析整体替换）。chat[0] 上其余字段（rpg 聚合、摘要、表格、用户待办、
 * 关系聚合等）属于整个聊天，重新分析开场白 / 切换开场白 swipe 时必须原样保留。
 */
export const MESSAGE_DELTA_KEYS = Object.freeze([
    'timestamp', 'scene', 'costumes', 'items', 'deletedItems', 'deletedAgenda', 'events', 'affection',
    'npcs', 'agenda', 'mood', 'relationships', '_rpgChanges', 'tableContributions', '_manualRpgEdits',
    '_bg', '_aiScanned', '_skipHorae',
]);

/** 只保留楼层增量字段的副本（用于 swipe 版本缓存，避免缓存 chat[0] 的全局数据） */
export function pickMessageDelta(meta) {
    const out = {};
    if (!meta) return out;
    for (const key of MESSAGE_DELTA_KEYS) {
        if (meta[key] !== undefined) out[key] = JSON.parse(JSON.stringify(meta[key]));
    }
    return out;
}

/** 保存 chat[0] 上属于整个聊天的数据（非增量字段 + 用户待办 + 关系聚合 + 物品） */
export function saveChatWideMeta(meta) {
    if (!meta) return null;
    const saved = { rest: {}, userAgenda: [], items: null, relationships: null };
    for (const [key, value] of Object.entries(meta)) {
        if (!MESSAGE_DELTA_KEYS.includes(key)) saved.rest[key] = value;
    }
    saved.userAgenda = (meta.agenda || []).filter(a => a && a.source !== 'ai');
    saved.items = meta.items ? { ...meta.items } : null;
    saved.relationships = meta.relationships || null;
    return saved;
}

/** 恢复 chat[0] 的聊天级数据：非增量字段原样放回；用户待办与新分析的待办合并；物品不因重新分析丢失 */
export function restoreChatWideMeta(meta, saved) {
    if (!meta || !saved) return;
    for (const [key, value] of Object.entries(saved.rest)) meta[key] = value;
    if (saved.userAgenda.length) {
        const fresh = (meta.agenda || []).filter(a => !saved.userAgenda.some(u => u.text === a.text));
        meta.agenda = [...saved.userAgenda, ...fresh];
    }
    if (saved.items) meta.items = { ...saved.items, ...(meta.items || {}) };
    if (saved.relationships) meta.relationships = saved.relationships;
}

/** 楼层元数据中是否已有可撤销的状态增量 */
export function metaHasState(meta) {
    if (!meta) return false;
    return !!(meta.timestamp?.story_date || meta.scene?.location || meta.scene?.characters_present?.length
        || Object.keys(meta.items || {}).length || (meta.deletedItems || []).length
        || Object.keys(meta.costumes || {}).length || Object.keys(meta.affection || {}).length
        || Object.keys(meta.npcs || {}).length || (meta.events || []).length
        || (meta.agenda || []).length || (meta.deletedAgenda || []).length || (meta.relationships || []).length
        || Object.keys(meta.mood || {}).length || meta._rpgChanges || meta.tableContributions);
}

/** 把 HUD 手动修改（_manualRpgEdits）叠加回 _rpgChanges，手动值优先 */
export function overlayManualRpg(meta) {
    const manual = meta?._manualRpgEdits;
    if (!manual) return;
    if (!meta._rpgChanges) meta._rpgChanges = {};
    const ch = meta._rpgChanges;
    for (const key of ['bars', 'status', 'levels', 'xp']) {
        if (!manual[key]) continue;
        if (!ch[key]) ch[key] = {};
        for (const [owner, val] of Object.entries(manual[key])) {
            if (key === 'bars') ch.bars[owner] = { ...(ch.bars[owner] || {}), ...val };
            else ch[key][owner] = val;
        }
    }
}

/**
 * 把一次分析结果提交到楼层 idx：替换该楼层旧增量（不叠加）→ 复用 applyParsedToMessage 合并 →
 * 写分析标记 → 必要时从全部楼层重放聚合数据。不触碰 message.mes。
 *
 * @param manager horaeManager
 * @param {{kind:'changes'|'nochange', parsed?:object}} result
 * @param {{fp:string, swipeId:number}} job
 * @param {{preserve?: (oldMeta, idx) => ((newMeta) => void)}} hooks 保留摘要压缩标记 / chat[0] 全局数据等
 * @returns {{meta:object, rebuilt:boolean}}
 */
export function applyAnalysisResult(manager, idx, result, job, hooks = {}) {
    const chat = manager.getChat();
    const message = chat[idx];
    const oldMeta = message.horae_meta || null;
    const replacing = metaHasState(oldMeta) || !!getBgMarker(message);
    const isTail = idx === chat.length - 1;
    const restore = hooks.preserve ? hooks.preserve(oldMeta, idx) : null;
    const manualRpg = oldMeta?._manualRpgEdits ? JSON.parse(JSON.stringify(oldMeta._manualRpgEdits)) : null;

    message.horae_meta = createEmptyMeta();
    if (result.kind === 'changes') manager.applyParsedToMessage(idx, result.parsed);
    const meta = message.horae_meta;
    if (restore) restore(meta);
    if (manualRpg) {
        meta._manualRpgEdits = manualRpg;
        overlayManualRpg(meta);
    }
    if (!meta.timestamp.absolute) meta.timestamp.absolute = new Date().toISOString();
    meta._bg = {
        v: BG_MARKER_VERSION,
        status: result.kind === 'changes' ? BG_STATUS.DONE : BG_STATUS.NO_CHANGE,
        fp: job.fp,
        swipeId: job.swipeId,
        at: new Date().toISOString(),
    };

    // 末尾新楼层首次提交：applyParsedToMessage 已做增量合并（与旧版新消息路径一致）；
    // 替换旧增量、历史楼层、手动 HUD 覆盖时一律从全部楼层重放，旧增量随之撤销
    const rebuilt = replacing || !isTail || !!manualRpg;
    if (rebuilt) {
        manager.rebuildTableData();
        manager.rebuildRelationships();
        manager.rebuildLocationMemory();
        manager.rebuildRpgData();
    }
    return { meta, rebuilt };
}

/**
 * 后台分析调度器
 *
 * deps:
 *  - getChat(): 当前 chat 数组
 *  - getChatKey(): 当前聊天唯一标识（chatId + groupId）
 *  - analyze(job): Promise<string> 发起辅助模型请求，返回原始文本
 *  - parse(raw): parseBgResponse 结果
 *  - commit(job, result): 将结果写入 job.message（同步或异步）；仅在校验通过后调用
 *  - markFailed(job, reason): 写入失败标记
 *  - onStatus(job, state): UI 状态回调（queued / running / done / failed / stale）
 *  - log(level, ...args)
 */
export class BackgroundAnalyzer {
    constructor(deps) {
        this.deps = deps;
        this.queue = [];
        this.running = null;
        this._idleWaiters = [];
        this._runtime = new WeakMap(); // message -> 'queued' | 'running'
        this._generation = 0;          // reset() 时自增，用于作废旧循环
    }

    _log(level, ...args) {
        try { this.deps.log?.(level, ...args); } catch { /* ignore */ }
    }

    /** 构造任务快照：所有身份字段都在入队时捕获 */
    _makeJob(message, opts = {}) {
        return {
            message,
            chatKey: this.deps.getChatKey(),
            swipeId: getSwipeId(message),
            fp: fingerprintText(message?.mes),
            force: !!opts.force,
            reason: opts.reason || 'auto',
            enqueuedAt: Date.now(),
        };
    }

    /** 任务是否仍指向当前聊天中的同一楼层、同一版本、同一正文 */
    isJobCurrent(job) {
        if (!job?.message) return false;
        if (job.chatKey !== this.deps.getChatKey()) return false;
        const chat = this.deps.getChat();
        if (!Array.isArray(chat) || !chat.includes(job.message)) return false;
        if (getSwipeId(job.message) !== job.swipeId) return false;
        if (fingerprintText(job.message.mes) !== job.fp) return false;
        return true;
    }

    indexOfJob(job) {
        const chat = this.deps.getChat();
        return Array.isArray(chat) ? chat.indexOf(job.message) : -1;
    }

    getRuntimeState(message) {
        return message ? (this._runtime.get(message) || null) : null;
    }

    /** 是否有未完成任务（可选限定为当前聊天） */
    hasPending(chatKey = null) {
        const match = (j) => chatKey == null || j.chatKey === chatKey;
        return (this.running && match(this.running)) || this.queue.some(match);
    }

    /**
     * 安排分析
     * @returns {boolean} 是否真正入队
     */
    schedule(messageIndex, opts = {}) {
        const chat = this.deps.getChat();
        const message = chat?.[messageIndex];
        if (!message || message.is_user || message.is_system) return false;
        if (message.horae_meta?._skipHorae) return false;
        if (!String(message.mes ?? '').trim()) return false;
        if (!opts.force && isMessageAnalyzed(message)) return false;

        const job = this._makeJob(message, opts);

        // 同一楼层同一版本已在运行 → 不重复
        if (this.running && this.running.message === message && this.running.fp === job.fp
            && this.running.swipeId === job.swipeId && this.running.chatKey === job.chatKey) {
            if (!opts.force) return false;
        }
        // 队列中同一楼层只保留最新版本
        const existingIdx = this.queue.findIndex(j => j.message === message);
        if (existingIdx >= 0) {
            const old = this.queue[existingIdx];
            if (old.fp === job.fp && old.swipeId === job.swipeId && old.chatKey === job.chatKey) {
                old.force = old.force || job.force;
                return false;
            }
            this.queue.splice(existingIdx, 1);
        }
        this.queue.push(job);
        this._runtime.set(message, 'queued');
        this._emit(job, 'queued');
        this._pump();
        return true;
    }

    /** 丢弃所有排队任务（切换聊天时）；运行中的任务会在提交前被校验拒绝 */
    reset() {
        for (const job of this.queue) {
            this._runtime.delete(job.message);
            this._emit(job, 'stale');
        }
        this.queue = [];
        this._generation++;
        this._checkIdle();
    }

    /** 等待（当前聊天）后台任务清空；超时返回 false */
    waitForIdle(timeoutMs = 60000, chatKey = null) {
        if (!this.hasPending(chatKey)) return Promise.resolve(true);
        return new Promise((resolve) => {
            const waiter = { chatKey, resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._idleWaiters = this._idleWaiters.filter(w => w !== waiter);
                resolve(false);
            }, Math.max(0, timeoutMs));
            this._idleWaiters.push(waiter);
        });
    }

    _checkIdle() {
        if (!this._idleWaiters.length) return;
        const still = [];
        for (const w of this._idleWaiters) {
            if (!this.hasPending(w.chatKey)) {
                clearTimeout(w.timer);
                w.resolve(true);
            } else {
                still.push(w);
            }
        }
        this._idleWaiters = still;
    }

    _emit(job, state, extra) {
        // 终态先清掉运行时状态，保证回调里读到的显示状态是最终结果
        // （同一楼层若已有新版本在排队，保留其 queued 状态）
        if ((state === 'done' || state === 'failed' || state === 'stale')
            && this.running === job && this._runtime.get(job.message) === 'running') {
            this._runtime.delete(job.message);
        }
        try { this.deps.onStatus?.(job, state, extra); } catch (err) { this._log('warn', 'onStatus failed', err); }
    }

    /** 取出当前聊天中楼层号最小的任务；过期任务直接丢弃 */
    _takeNext() {
        while (this.queue.length) {
            let bestI = -1;
            let bestIdx = Infinity;
            for (let i = 0; i < this.queue.length; i++) {
                const job = this.queue[i];
                if (!this.isJobCurrent(job)) continue;
                const idx = this.indexOfJob(job);
                if (idx < bestIdx) { bestIdx = idx; bestI = i; }
            }
            if (bestI < 0) {
                for (const job of this.queue) {
                    this._runtime.delete(job.message);
                    this._emit(job, 'stale');
                }
                this.queue = [];
                return null;
            }
            return this.queue.splice(bestI, 1)[0];
        }
        return null;
    }

    _pump() {
        if (this.running) return;
        const job = this._takeNext();
        if (!job) { this._checkIdle(); return; }
        this.running = job;
        const gen = this._generation;
        this._runtime.set(job.message, 'running');
        this._emit(job, 'running');
        this._runJob(job)
            .catch(err => this._log('error', 'background job crashed', err))
            .finally(() => {
                if (this._runtime.get(job.message) === 'running') this._runtime.delete(job.message);
                this.running = null;
                if (gen !== this._generation) this._log('info', 'analyzer was reset during job');
                // 让出事件循环，避免同步递归
                setTimeout(() => this._pump(), 0);
            });
    }

    async _runJob(job) {
        if (!this.isJobCurrent(job)) { this._emit(job, 'stale'); return; }
        if (!job.force && isMessageAnalyzed(job.message)) { this._emit(job, 'done'); return; }

        let raw;
        try {
            raw = await this.deps.analyze(job);
        } catch (err) {
            const reason = err?.message || String(err || 'unknown error');
            if (!this.isJobCurrent(job)) { this._emit(job, 'stale'); return; }
            this._log('warn', `analysis request failed: ${reason}`);
            await this.deps.markFailed(job, reason);
            this._emit(job, 'failed', { reason });
            return;
        }

        // 结果返回时再次校验：聊天、楼层、swipe、正文都必须未变
        if (!this.isJobCurrent(job)) {
            this._log('info', 'discarding stale analysis result');
            this._emit(job, 'stale');
            return;
        }

        const result = this.deps.parse(raw);
        if (result.kind === 'invalid') {
            this._log('warn', `invalid analysis response: ${result.reason}`);
            await this.deps.markFailed(job, result.reason);
            this._emit(job, 'failed', { reason: result.reason });
            return;
        }

        try {
            await this.deps.commit(job, result);
            this._emit(job, 'done', { kind: result.kind });
        } catch (err) {
            const reason = `commit failed: ${err?.message || err}`;
            this._log('error', reason, err);
            if (this.isJobCurrent(job)) await this.deps.markFailed(job, reason);
            this._emit(job, 'failed', { reason });
        }
    }
}

/** 默认后台分析提示词（无资源文件时的最终兜底） */
export const DEFAULT_BG_PROMPT_EN = `[Horae Background State Analyzer]
You are an independent state recorder, NOT the story author. Read ONE completed story reply (plus the user action that preceded it), identify the ESTABLISHED state changes, and output them in the private data format below. Your output is read only by a program and never appears in the story.

=== Core rules ===
1. Record only facts that actually happened. Do NOT record suggestions, planned or intended actions, hypotheticals, conditional outcomes, imagined scenes, lies told in dialogue, or user actions that have not been carried out.
2. Scene basics (time / location / characters / costume) are written EVERY time, as the current values after this reply; when the reply does not change one, copy it from [Current State]. Every other field is incremental: omit it if it did not change. Never re-register existing items, skills, NPCs, relationships or agenda entries.
3. Never invent information that neither the text nor [Current State] provides. Do not make up a time, outfit or stat just to fill a field; if a scene basic is still unknown, leave that line out. (Affection and relationships are judgments from the story, not invention; see rules 12 and 13.)
4. Time: in-story time only, never real-world time. If an "Authoritative story clock" line is given, it overrides the time in [Current State]; otherwise start from the time in [Current State]. Advance it only by the time that actually passes in the story (a conversation moves the clock a little; idle dialogue does not change the date). Write calendar dates as year/month/day with slashes, e.g. 2020/01/10 (month/day such as 01/10 if the year is unknown); a fictional calendar keeps its own format. Never write a format placeholder such as YYYY, MM/DD or HH:MM literally: if the date is unknown, write only the time of day (e.g. after school, 20:00) or keep the value from [Current State].
5. Scene: characters: lists the full current set of present characters; write one costume: line for each of them.
6. Numeric values (HP/MP/SP bars, level, currency totals) are written as the CURRENT ABSOLUTE value after the change, computed from [Current State]. If unchanged, omit them.
7. User action: state changes caused by the user's action that the reply confirms (or that the user has clearly carried out) must be recorded too, unless that action is marked as already settled.
8. Events: write one event: line if this reply contains a story event worth tracing; trivial chit-chat may have no event.
9. Because the scene basics are always written, always output a <horae> block; output <horaenochange/> only when neither the story nor [Current State] establishes any scene.
10. Output data tags only: no explanation, no story text, no code fences. Write values in the same language as the story text.
11. "{{speaker}}" is only the name of the card that wrote this reply. It may be a narrator / GM rather than a person in the story. Do NOT list it in characters:, npc:, affection: or costume: unless it appears in the story text as a character in its own right. Record what each character says, does, wears or owns under THAT character's own name, never under the speaker's name. The "N011"-style numbers in front of NPCs in [Current State] are display IDs, not part of the name: write only the name itself (npc:Alice|…, not npc:N001 Alice｜…), and use the half-width "|" separator.
12. Affection (affection:, NPC toward {{user}} only):
   - When an NPC first interacts with {{user}}, or a present NPC has no affection in [Current State] yet, give a starting value from their current relationship (stranger 0-20 / acquaintance 30-50 / friend 50-70 / lover 70-90).
   - After that, start from the value in [Current State] and write the new total only when an interaction meaningfully changes their attitude: small steps for everyday interaction, big changes only for major events.
13. Relationships evolve; they are not re-judged from scratch (applies to npc:'s "@relationship to {{user}}" and rel:'s relationship type):
   - The relationship already in [Current State] is the base; this reply only modifies it. Write the complete relationship after "existing relationship + this change", never a fresh summary of this reply alone.
   - A lasting bond (lovers, close friends, family, rivals...) is NOT replaced by one mission, one conversation or a temporary role (bodyguard, employer, guide, teammate...). Put temporary roles in the note (npc: ~note:, rel: the note after "|").
   - npc:'s "@relationship to {{user}}" is a SHORT summary only (e.g. "lover", "employer and childhood friend", a few words). The history of the relationship, concrete experiences and recent developments go into that NPC's ~note:. If the relationship in [Current State] is already long, move the details into ~note: in this update and keep only the summary. Never append parenthetical notes or event records to the relationship (e.g. "stranger (warned…, recorded…)"); those always go into ~note:.
   - A written ~note: replaces the old note entirely (shown as "notes" in the snapshot): keep what still matters from the old note (including non-relationship information), then merge in the new details; skip trivial details.
   - Upgrade, downgrade or change the relationship type only when the story shows an explicit event (confession, breakup, betrayal, reconciliation, marriage...).
   - A written value replaces the old one entirely, so always write the complete current relationship; omit the line when neither the relationship nor its note changed.
   - rel:'s note holds the important RECENT shared experiences of the two. "Recent" means recent in story time by common sense (the last days to weeks), not the last few turns of dialogue: keep the parts of the old note that still matter, merge in new important events, drop what is outdated, and leave out trivial dialogue details.

The "format reference" sections below were originally written for another context. Any wording like "must include at the end of every reply", "required every turn", "missing = fail" does NOT apply here; the core rules above take precedence.

=== Current State (before this reply, read-only) ===
{{state}}

=== Preceding user action ===
{{previousUserMessage}}

=== Story reply to analyze (speaker: {{speaker}}) ===
<story>
{{content}}
</story>

=== Output format ===
<horae>
time:story date and time (every time; see rule 4)
location:place (every time; use · for nested places, keep names identical to Current State)
atmosphere:mood of the scene (only if changed)\${sceneDescLine}
characters:full names of all present characters, comma separated (every time)
costume:name=outfit description (every time, one line per present character)
item:emoji name(qty)|description=holder@exact location (newly obtained, or quantity/holder/location changed)
item!:... / item!!:... (important / key items, description required)
item-:item name (consumed, lost, or no longer tracked)
affection:NPC name=new total (NPC toward {{user}} only; only on change, first appearance, or when still missing — rule 12)
npc:name|appearance=personality@short relationship to {{user}}~gender:x~age:x~race:x~job:x~note:relationship details and recent developments (full on first appearance; later only changed fields, but always keep "name|", e.g. npc:name|=@new relationship; relationship per rule 13)\${relLine}\${moodLine}
agenda:date|content (new promise/plan/task)
agenda-:content keyword (completed / invalidated)
</horae>
<horaeevent>
event:level|summary (level: normal/important/critical)
</horaeevent>
{{modules}}`;

export const DEFAULT_BG_PROMPT_ZH = `【Horae 后台状态分析器】
你是独立运行的“状态记录员”，不是故事作者。你的唯一任务：阅读下方一条已经完成的剧情回复（以及它之前的用户行动），找出其中【已确立的状态变化】，按下方的私有数据格式输出。你的输出只会被程序读取，永远不会出现在剧情中。

═══ 基本原则 ═══
1. 只记录已经实际发生的事实。建议、计划/打算中的行动、假设、条件性的可能结果、想象画面、台词中的谎言、用户尚未执行的行动——一律不记录。
2. 场景基础（time/location/characters/costume）每次都写，写本条回复之后的当前值；本条回复没有改变的，照抄【当前状态】中的值。其他字段只做增量：没有变化就不写。禁止重复登记已有的物品、技能、NPC、关系、待办。
3. 禁止编造：文本和【当前状态】都没有提供的信息不写。不要为了“填满字段”而虚构时间、服装、数值；场景基础仍未知时，省略该行。（好感度与关系是根据剧情做出的判断，不属于编造，见第12、13条。）
4. 时间：必须是故事内时间，绝不能使用现实时间。若给出了「权威故事时钟」行，以它为准（覆盖【当前状态】中的时间）；否则以【当前状态】的时间为基准。只按剧情实际流逝推进（一段对话只推进少许；闲聊不改变日期）。公历日期按 年/月/日 用斜杠写，如 2020/01/10（年份未知时只写月/日，如 01/10）；虚构历法保留其原有写法。绝不能照抄 YYYY、MM/DD、HH:MM 之类的格式占位符：日期未知时只写时段（如 放学后、20:00），或沿用【当前状态】中的值。
5. 场景：characters: 写当前完整的在场名单；名单中每个角色各写一行 costume:。
6. 数值类（HP/MP/SP 等属性条、等级、货币）写变化后的【当前绝对值】，以【当前状态】为基准计算；没有变化就不写。
7. 用户行动：本条回复确认发生（或用户已明确执行）的用户行动所造成的状态变化也要记录；若该行动被标注为“已结算”，则不得重复记录。
8. 事件：本条回复中有值得追溯的剧情事件时写一条 event:；纯闲聊、无实质进展可以不写。
9. 场景基础每次都写，因此始终输出 <horae> 块；只有剧情和【当前状态】都没有确立任何场景时，才输出：<horaenochange/>
10. 只输出数据标签：不要解释，不要正文，不要代码块标记。字段内容使用与剧情相同的语言。
11. 「{{speaker}}」只是写出这条回复的角色卡名称，可能是旁白/GM/叙述者，而不是剧情中的人物。除非它在剧情正文中作为角色本人出现，否则不得把它写入 characters:/npc:/affection:/costume:。剧情中每个角色的言行、服装、物品，记在【该角色自己的名字】下，绝不能记在发言者名下。【当前状态】里 NPC 前面的「N011」之类是显示编号，不是名字的一部分：写名字时只写名字本身（如 npc:食蜂操祈|…，不是 npc:N001 食蜂操祈｜…），分隔符用半角「|」。
12. 好感度（affection:，仅 NPC 对{{user}}）：
   · NPC 首次与{{user}}互动，或【当前状态】中该在场 NPC 还没有好感度时，按双方当前关系给出初始值（陌生0-20 / 熟人30-50 / 朋友50-70 / 恋人70-90）。
   · 之后以【当前状态】中的值为基准，只在互动使其态度发生实质变化时写变化后的新总值；日常互动小幅调整，重大事件才大幅变化。
13. 关系是逐步演进的，不是每次重新判定（适用于 npc: 的「@与{{user}}的关系」和 rel: 的关系类型）：
   · 【当前状态】中已有的关系是基础，本条回复只是修正：写“已有关系 + 本次变化”之后的完整关系，不能只依据本条回复重新概括。
   · 长期纽带（恋人、挚友、家人、宿敌等）不会因一次任务、一段对话或临时身份（护卫、雇主、向导、队友等）而被替换；临时身份写进备注（npc: 用 ~备注:，rel: 用「|」后的备注）。
   · npc: 的「@与{{user}}的关系」只写简短的关系概括（如“恋人”“雇主兼青梅竹马”，约15字以内）。关系的来龙去脉、具体经历与近期动态写进该 NPC 的 ~备注:。若【当前状态】中的关系已经很长，本次更新时把细节移入 ~备注:，关系只保留概括。不要在关系里加括号说明或事件记录（如“陌生人(警告…,记录…)”），这些一律写进 ~备注:。
   · ~备注: 写入会整体覆盖旧备注（快照中显示为“补充”）：保留旧备注中仍然重要的内容（包括非关系类的信息），再并入新的细节；不写琐碎细节。
   · 只有剧情中发生明确事件（表白、分手、背叛、和解、结婚等）时，才能升级、降级或改变关系类型。
   · 写入会整体覆盖旧值，所以每次都写完整的当前关系；关系与备注都没有变化时不写该行。
   · rel: 的备注写两人之间“近期”的重要共同经历。“近期”按故事内的常识理解（最近几天到几周），不是最近几轮对话：保留旧备注中仍然相关的内容，并入新的重要事件，删去已经过时的，不写琐碎的对话细节。

下方各“格式参考”原本是为其他场景编写的，其中“每回合必须/必填/缺少=不合格/回复末尾必须包含”等要求在此【一律不适用】，以上基本原则优先。

═══ 当前状态（本条回复之前，只读） ═══
{{state}}

═══ 之前的用户行动 ═══
{{previousUserMessage}}

═══ 待分析的剧情回复（发言者：{{speaker}}） ═══
<story>
{{content}}
</story>

═══ 输出格式 ═══
<horae>
time:剧情日期与时间（每次都写，见第4条）
location:地点（每次都写；多级地点用·分隔，名称与当前状态保持一致）
atmosphere:氛围（仅变化时）\${sceneDescLine}
characters:当前在场角色全名,逗号分隔（每次都写）
costume:角色名=服装描述（每次都写，每个在场角色一行）
item:emoji物品名(数量)|描述=持有者@精确位置（新获得，或已有物品的数量/持有者/位置改变）
item!:… / item!!:…（重要/关键物品，描述必填）
item-:物品名（消耗、丢失或不再需要追踪时）
affection:NPC名=新好感度总值（仅NPC对{{user}}，仅变化、首次登场或尚无好感度时，见第12条）
npc:名|外貌=性格@与{{user}}的关系概括~性别:值~年龄:值~种族:值~职业:值~备注:关系细节与近期动态（首次登场写完整；之后只写变化的字段，但必须保留「名|」，如 npc:名|=@新关系；关系按第13条）\${relLine}\${moodLine}
agenda:订立日期|内容（新的约定/计划/任务）
agenda-:内容关键词（已完成/已失效）
</horae>
<horaeevent>
event:重要程度|事件简述（30-50字，重要程度：一般/重要/关键）
</horaeevent>
{{modules}}`;
