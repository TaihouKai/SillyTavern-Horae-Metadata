/**
 * Canon Engine 故事时钟（只读）与时间占位符兜底。
 * 运行：node --test tests/canonClock.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horaeManager, bg, msg, setup, parse, commit } from './helpers.mjs';
import { readCanonClock, formatCanonClockLine, stripTimePlaceholders, sameStoryDate, sameStoryTime, canonLeadMinutes } from '../utils/timeUtils.js';

const CLOCK = { active: true, packId: 'p', date: '2020/09/18', time: '20:00', tick: 88860, tickHi: 88860, day: 61, minute: 1200, weekday: 5, label: '2020-09-18 20:00 (D61)' };

test('readCanonClock feature-detects the global API', () => {
    assert.equal(readCanonClock({}), null, 'Canon Engine not installed');
    assert.equal(readCanonClock({ CanonEngine: {} }), null, 'no api');
    assert.equal(readCanonClock({ CanonEngine: { api: { getClock: () => ({ active: false }) } } }), null, 'inactive chat');
    assert.equal(readCanonClock({ CanonEngine: { api: { getClock: () => { throw new Error('x'); } } } }), null, 'throwing API');
    assert.deepEqual(readCanonClock({ CanonEngine: { api: { getClock: () => CLOCK } } }), CLOCK);
});

test('clock line: labelled, start vs committed end, no-date and uncertain variants, zh/en', () => {
    const en = formatCanonClockLine(CLOCK, { zh: false, phase: 'start' });
    assert.match(en, /^\[Authoritative story clock \(Canon Engine\): 2020\/09\/18 20:00\]/);
    assert.match(en, /advance only by time that passes in the analyzed text/);
    assert.match(formatCanonClockLine(CLOCK, { phase: 'end' }), /do not advance it further/);
    const zh = formatCanonClockLine(CLOCK, { zh: true, phase: 'start' });
    assert.match(zh, /^【权威故事时钟（Canon Engine）：2020\/09\/18 20:00】/);
    assert.match(formatCanonClockLine(CLOCK, { zh: true, phase: 'end' }), /不要再推进/);
    const noDate = formatCanonClockLine({ ...CLOCK, date: null }, { zh: false });
    assert.match(noDate, /clock \(Canon Engine\): 20:00\]/);
    assert.match(noDate, /No calendar date/);
    assert.match(formatCanonClockLine({ ...CLOCK, tickHi: CLOCK.tick + 60 }, { zh: true }), /以此下限为准/);
    assert.equal(formatCanonClockLine(null), '');
});

test('placeholders are stripped; real dates and time-of-day words are kept', () => {
    assert.deepEqual(stripTimePlaceholders('MM/DD 放学后'), { text: '放学后', stripped: true });
    assert.equal(stripTimePlaceholders('YYYY/MM/DD HH:MM').text, '');
    assert.equal(stripTimePlaceholders('日期 时间').text, '');
    assert.equal(stripTimePlaceholders('date time').text, '');
    assert.equal(stripTimePlaceholders('HH:MM 放学后').text, '放学后');
    for (const ok of ['2020/09/18 放学后', '放学后', 'D61 清晨', '玄昭十五年 8/16', 'Monday morning']) {
        assert.deepEqual(stripTimePlaceholders(ok), { text: ok, stripped: false }, ok);
    }
    assert.ok(sameStoryDate('2020/9/18 放学后', '2020/09/18'));
    assert.ok(!sameStoryDate('2020/09/19', '2020/09/18'));
});

test('"time:MM/DD 放学后" never stores MM/DD: previous date + 放学后, or 放学后 alone', () => {
    // 之前没有日期
    let chat = [msg('开场'), msg('放学了', { user: true }), msg('放学后他们去了便利店。')];
    setup(chat);
    commit(chat, 2, parse('<horae>\ntime:MM/DD 放学后\nlocation:便利店\n</horae>'));
    assert.equal(horaeManager.getLatestState().timestamp.story_date, '放学后');

    // 之前已有日期：保留日期，只换时段
    chat = [msg('开场'), msg('走吧', { user: true }), msg('早上到校。'), msg('放学了', { user: true }), msg('放学后他们去了便利店。')];
    setup(chat);
    commit(chat, 2, parse('<horae>\ntime:2020/09/18 08:00\nlocation:学校\n</horae>'));
    commit(chat, 4, parse('<horae>\ntime:MM/DD 放学后\nlocation:便利店\n</horae>'));
    assert.equal(horaeManager.getLatestState().timestamp.story_date, '2020/09/18 放学后');
    assert.ok(!JSON.stringify(chat[4].horae_meta.timestamp).includes('MM'));
    assert.ok(!('_placeholderStripped' in chat[4].horae_meta.timestamp));

    // 全是占位符：时间保持不变
    const idx = chat.push(msg('继续', { user: true }), msg('……')) - 1;
    commit(chat, idx, parse('<horae>\ntime:YYYY/MM/DD HH:MM\nlocation:便利店\n</horae>'));
    const ts = horaeManager.getLatestState().timestamp;
    assert.equal(ts.story_date, '2020/09/18 放学后');
});

test('with a Canon clock baseline, "放学后…" is recorded on 2020/09/18', () => {
    // 模型按提示词以权威时钟为基准输出日期；解析与合并保持该日期
    const chat = [msg('开场'), msg('放学了', { user: true }), msg('放学后他们去了便利店。')];
    setup(chat);
    commit(chat, 2, parse('<horae>\ntime:2020/09/18 放学后\nlocation:便利店\n</horae>'));
    assert.equal(horaeManager.getLatestState().timestamp.story_date, '2020/09/18 放学后');
});

test('prompts: authoritative clock overrides [Current State]; placeholders forbidden; zh/en in sync', () => {
    for (const p of [bg.DEFAULT_BG_PROMPT_EN, bg.DEFAULT_BG_PROMPT_ZH]) {
        assert.ok(!/MM\/DD if the year is unknown|年份未知时写 MM\/DD/.test(p), 'no MM/DD fallback wording');
        assert.ok(!/^time:(date time|日期 时间)/m.test(p), 'format line has no copyable tokens');
    }
    assert.match(bg.DEFAULT_BG_PROMPT_EN, /"Authoritative story clock" line is given, it overrides the time in \[Current State\]/);
    assert.match(bg.DEFAULT_BG_PROMPT_EN, /Never write a format placeholder such as YYYY, MM\/DD or HH:MM literally/);
    assert.match(bg.DEFAULT_BG_PROMPT_ZH, /若给出了「权威故事时钟」行，以它为准/);
    assert.match(bg.DEFAULT_BG_PROMPT_ZH, /绝不能照抄 YYYY、MM\/DD、HH:MM 之类的格式占位符/);
});

test('sameStoryTime: same day but drifted time is a mismatch (follow Canon), small differences are tolerated', () => {
    assert.ok(!sameStoryTime('15:30', '13:00'), '2.5 h drift within the same day');
    assert.ok(sameStoryTime('13:05', '13:00'), 'within tolerance');
    assert.ok(!sameStoryTime('午后', '13:00'), 'vague label vs exact Canon time');
    assert.ok(!sameStoryTime('', '13:00'), 'missing time');
    assert.ok(sameStoryTime('午后', ''), 'Canon has no time');
});

test('canonLeadMinutes: Horae follows Canon only when Canon is ahead', () => {
    assert.equal(canonLeadMinutes('2020/09/19', '15:30', '2020/09/19', '13:00'), -150, 'Horae ahead: no follow');
    assert.equal(canonLeadMinutes('2020/09/19', '13:00', '2020/09/20', '08:00'), 1140, 'Canon a day ahead');
    assert.equal(canonLeadMinutes('2020/09/19', '午后', '2020/09/19', '13:00'), 780, 'vague Horae time counts as 00:00');
    assert.equal(canonLeadMinutes('第三纪元某日', '13:00', '2020/09/19', '13:00'), null, 'not comparable');
});
