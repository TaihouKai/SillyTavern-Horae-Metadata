/**
 * 属性条自动回复：不经 AI，按剧情时间推算，不消耗 token。
 * 只改返回的快照（getRpgStateAt / HUD 快照），楼层里记录的数值不变：关掉开关就回到原值。
 * 每个属性条从它最后一次被写入（AI 分析、手动编辑、开局）时的剧情时间开始，
 * 每小时回复 上限×X%，不超过上限；剧情时间未知或倒退时不回复。
 *
 * 配置：settings.rpgRegen = { hp: { on: true, pct: 10 }, mp: { on: false, pct: 20 }, ... }（按属性条 key）
 */

import { parseStoryDate, extractLeadingDate } from '../utils/timeUtils.js';

/** 配置 → Map<key, 每小时回复比例(0~1)>；没有开启的属性条不在其中 */
export function regenRates(config) {
    const rates = new Map();
    for (const [key, c] of Object.entries(config || {})) {
        const pct = Number(c?.pct);
        if (c?.on && Number.isFinite(pct) && pct > 0) rates.set(key, Math.min(pct, 100) / 100);
    }
    return rates;
}

const _hm = (s) => { const m = String(s ?? '').match(/(\d{1,2})[:：](\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

function _day(date) {
    const p = parseStoryDate(extractLeadingDate(date) || String(date ?? ''));
    return p?.type === 'standard' && p.month && p.day ? Date.UTC(p.year ?? 2000, p.month - 1, p.day) / 86400000 : null;
}

/** 两个剧情时间点 {date, time} 之间经过的分钟数；无法计算时返回 null */
export function storyElapsedMinutes(from, to) {
    if (!from || !to) return null;
    const t1 = _hm(from.time), t2 = _hm(to.time);
    if (t1 === null || t2 === null) return null;
    const d1 = _day(from.date), d2 = _day(to.date);
    if (d1 !== null && d2 !== null) return (d2 - d1) * 1440 + (t2 - t1);
    // 虚构历法等无法解析的日期：同一天才按时刻相减
    if (String(from.date || '').trim() === String(to.date || '').trim()) return t2 - t1;
    return null;
}

/**
 * 顺序回放楼层时使用的追踪器：setTime 记下当前剧情时间，noteBars 记下属性条被写入的时间，
 * apply 在快照上补上回复量。没有开启任何属性条时返回 null。
 */
export function createRegenTracker(config) {
    const rates = regenRates(config);
    if (!rates.size) return null;
    const marks = new Map(); // owner → Map<key, {date, time} | null>
    let now = null;
    return {
        setTime(ts) {
            if (!ts || (!ts.story_date && !ts.story_time)) return;
            now = { date: ts.story_date || '', time: ts.story_time || '' };
            // 剧情时间出现之前写入的属性条（如开局）从第一个已知时间开始算
            for (const m of marks.values()) for (const [k, v] of m) if (!v) m.set(k, now);
        },
        noteBars(bars, resolve = (n) => n) {
            for (const [raw, data] of Object.entries(bars || {})) {
                const owner = resolve(raw);
                if (!marks.has(owner)) marks.set(owner, new Map());
                for (const key of Object.keys(data || {})) if (rates.has(key)) marks.get(owner).set(key, now);
            }
        },
        apply(bars) {
            if (!now || !bars) return;
            for (const [owner, data] of Object.entries(bars)) {
                for (const [key, rate] of rates) {
                    const v = data?.[key];
                    const since = marks.get(owner)?.get(key);
                    if (!Array.isArray(v) || !since) continue;
                    const cur = Number(v[0]), max = Number(v[1]);
                    if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0 || cur >= max) continue;
                    const mins = storyElapsedMinutes(since, now);
                    if (!mins || mins <= 0) continue;
                    const next = Math.min(max, Math.floor(cur + max * rate * mins / 60));
                    if (next > cur) data[key] = [next, ...v.slice(1)];
                }
            }
        },
    };
}
