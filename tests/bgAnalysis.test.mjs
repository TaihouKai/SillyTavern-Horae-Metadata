/**
 * 后台分析调度器与私有协议解析的单元测试
 * 运行：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horaeManager, bg, msg, setup, parse } from './helpers.mjs';

const { BackgroundAnalyzer, fingerprintText, isMessageAnalyzed, BG_STATUS } = bg;

// ---------- 私有协议严格解析 ----------

test('parse: tagged response yields changes', () => {
    setup([msg('greeting')]);
    const r = parse('<horae>\nlocation:冬木市·教会\n</horae>\n<horaeevent>\nevent:重要|尤丝蒂娜抵达教会\n</horaeevent>');
    assert.equal(r.kind, 'changes');
    assert.equal(r.parsed.scene.location, '冬木市·教会');
    assert.equal(r.parsed.events.length, 1);
});

test('parse: explicit no-change marker', () => {
    assert.equal(parse('<horaenochange/>').kind, 'nochange');
    assert.equal(parse('  <horaenochange />  ').kind, 'nochange');
    // 空标签块也视为合法的「无变化」
    assert.equal(parse('<horae>\n</horae>').kind, 'nochange');
});

test('parse: think blocks are ignored', () => {
    const r = parse('<think>maybe <horae>location:假地点</horae></think><horaenochange/>');
    assert.equal(r.kind, 'nochange');
});

test('parse: plain prose / bare fields are rejected (no loose parsing)', () => {
    // Qwen 式裸字段输出不能被宽松解析成状态
    const r1 = parse('time: 2026/2/4 15:00\nlocation: 教会\nskill: 尤丝蒂娜|魔力放出');
    assert.equal(r1.kind, 'invalid');
    const r2 = parse('');
    assert.equal(r2.kind, 'invalid');
    const r3 = parse(null);
    assert.equal(r3.kind, 'invalid');
    const r4 = parse('她推开了教会的大门。');
    assert.equal(r4.kind, 'invalid');
});

test('parse: rpg-only block is accepted', () => {
    setup([msg('greeting')]);
    const r = parse('<horaerpg>\nhp:尤丝蒂娜=84/100\n</horaerpg>');
    assert.equal(r.kind, 'changes');
    assert.deepEqual(r.parsed.rpg.bars['尤丝蒂娜'].hp, [84, 100]);
});

test('fingerprint differs for different text and is stable', () => {
    assert.equal(fingerprintText('abc'), fingerprintText('abc'));
    assert.notEqual(fingerprintText('abc'), fingerprintText('abd'));
    assert.notEqual(fingerprintText(''), fingerprintText(' '));
});

// ---------- 调度器 ----------

function makeAnalyzer(chatRef, opts = {}) {
    const calls = [];
    const commits = [];
    const failures = [];
    const states = [];
    let chatKey = opts.chatKey || 'A';
    const pending = new Map(); // message -> resolve
    const analyzer = new BackgroundAnalyzer({
        getChat: () => chatRef.chat,
        getChatKey: () => chatKey,
        analyze: (job) => {
            calls.push(job);
            if (opts.manual) return new Promise((resolve, reject) => pending.set(job.message, { resolve, reject }));
            return Promise.resolve(opts.response ?? '<horaenochange/>');
        },
        parse: (raw) => parse(raw),
        commit: (job, result) => {
            commits.push({ job, result });
            job.message.horae_meta = job.message.horae_meta || {};
            job.message.horae_meta._bg = { status: result.kind === 'changes' ? BG_STATUS.DONE : BG_STATUS.NO_CHANGE, fp: job.fp, swipeId: job.swipeId };
        },
        markFailed: (job, reason) => {
            failures.push({ job, reason });
            job.message.horae_meta = job.message.horae_meta || {};
            job.message.horae_meta._bg = { status: BG_STATUS.FAILED, fp: job.fp, swipeId: job.swipeId, error: reason };
        },
        onStatus: (job, state) => states.push(state),
    });
    return {
        analyzer, calls, commits, failures, states, pending,
        setChatKey: (k) => { chatKey = k; },
    };
}

const flush = () => new Promise(r => setTimeout(r, 10));

test('scheduler: one commit per message version; duplicates are ignored', async () => {
    const chatRef = { chat: [msg('greeting'), msg('act', { user: true }), msg('reply one')] };
    setup(chatRef.chat);
    const h = makeAnalyzer(chatRef);
    assert.equal(h.analyzer.schedule(2), true);
    assert.equal(h.analyzer.schedule(2), false, 'same version queued twice');
    await h.analyzer.waitForIdle(1000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.commits.length, 1);
    assert.ok(isMessageAnalyzed(chatRef.chat[2]));
    // 已分析的同一版本不再请求（重渲染 / 重复事件）
    assert.equal(h.analyzer.schedule(2), false);
    await flush();
    assert.equal(h.calls.length, 1);
    // force（手动重新分析）可以再次请求
    assert.equal(h.analyzer.schedule(2, { force: true }), true);
    await h.analyzer.waitForIdle(1000);
    assert.equal(h.calls.length, 2);
});

test('scheduler: user / empty / sideplay messages are never analyzed', () => {
    const chatRef = { chat: [msg('greeting'), msg('act', { user: true }), msg('   '), msg('side')] };
    chatRef.chat[3].horae_meta = { _skipHorae: true };
    const h = makeAnalyzer(chatRef);
    assert.equal(h.analyzer.schedule(1), false);
    assert.equal(h.analyzer.schedule(2), false);
    assert.equal(h.analyzer.schedule(3), false);
});

test('scheduler: messages are analyzed in narrative order', async () => {
    const chatRef = { chat: [msg('g'), msg('u1', { user: true }), msg('a1'), msg('u2', { user: true }), msg('a2'), msg('a3')] };
    const h = makeAnalyzer(chatRef, { manual: true });
    h.analyzer.schedule(5);
    // 5 已经开始运行；随后排入 4 和 2，应先 2 后 4
    h.analyzer.schedule(4);
    h.analyzer.schedule(2);
    await flush();
    assert.equal(h.calls.length, 1);
    h.pending.get(chatRef.chat[5]).resolve('<horaenochange/>');
    await flush(); await flush();
    assert.equal(h.calls[1].message, chatRef.chat[2]);
    h.pending.get(chatRef.chat[2]).resolve('<horaenochange/>');
    await flush(); await flush();
    assert.equal(h.calls[2].message, chatRef.chat[4]);
    h.pending.get(chatRef.chat[4]).resolve('<horaenochange/>');
    assert.equal(await h.analyzer.waitForIdle(1000), true);
});

test('scheduler: result arriving after chat switch is discarded (never written to chat B)', async () => {
    const chatA = [msg('g'), msg('u', { user: true }), msg('reply in A')];
    const chatRef = { chat: chatA };
    const h = makeAnalyzer(chatRef, { manual: true });
    h.analyzer.schedule(2);
    await flush();
    // 切换到聊天 B（同一个数组引用被清空重填也必须拒绝）
    const chatB = [msg('g-B'), msg('u-B', { user: true }), msg('reply in B')];
    h.setChatKey('B');
    chatRef.chat = chatB;
    h.analyzer.reset();
    h.pending.get(chatA[2]).resolve('<horae>\nlocation:错误地点\n</horae>');
    await flush(); await flush();
    assert.equal(h.commits.length, 0);
    assert.equal(h.failures.length, 0);
    assert.equal(chatB[2].horae_meta, undefined);
    assert.ok(h.states.includes('stale'));
});

test('scheduler: result for a superseded swipe / edited text is discarded', async () => {
    const m = msg('swipe A text', { swipes: ['swipe A text'] });
    const chatRef = { chat: [msg('g'), msg('u', { user: true }), m] };
    const h = makeAnalyzer(chatRef, { manual: true });
    h.analyzer.schedule(2);
    await flush();
    // 用户切到新 swipe
    m.swipes.push('swipe B text');
    m.swipe_id = 1;
    m.mes = 'swipe B text';
    h.pending.get(m).resolve('<horaerpg>\nhp:尤丝蒂娜=10/100\n</horaerpg>');
    await flush(); await flush();
    assert.equal(h.commits.length, 0, 'late result of old swipe must not commit');

    // 编辑正文同理
    h.analyzer.schedule(2);
    await flush();
    m.mes = 'swipe B text (edited)';
    h.pending.get(m).resolve('<horaenochange/>');
    await flush(); await flush();
    assert.equal(h.commits.length, 0);
});

test('scheduler: failure is recorded, retryable, and does not commit', async () => {
    const chatRef = { chat: [msg('g'), msg('u', { user: true }), msg('reply')] };
    const h = makeAnalyzer(chatRef, { response: 'just some prose without tags' });
    h.analyzer.schedule(2);
    await h.analyzer.waitForIdle(1000);
    assert.equal(h.commits.length, 0);
    assert.equal(h.failures.length, 1);
    assert.equal(chatRef.chat[2].horae_meta._bg.status, BG_STATUS.FAILED);
    assert.equal(isMessageAnalyzed(chatRef.chat[2]), false);
    // 失败后可以重试（非 force 也可，因为失败不算已分析）
    assert.equal(h.analyzer.schedule(2), true);
    await h.analyzer.waitForIdle(1000);
    assert.equal(h.failures.length, 2);
});

test('scheduler: API exception is recorded as failure', async () => {
    const chatRef = { chat: [msg('g'), msg('u', { user: true }), msg('reply')] };
    const h = makeAnalyzer(chatRef);
    h.analyzer.deps.analyze = () => Promise.reject(new Error('辅助API缺少: API 密钥'));
    h.analyzer.schedule(2);
    await h.analyzer.waitForIdle(1000);
    assert.equal(h.failures.length, 1);
    assert.match(h.failures[0].reason, /API/);
});

test('parse: an opened but unclosed <horae> block is reported as cut off', () => {
    const r = parse('<horae>\ntime:2020/09/18 20:00\nlocation:便利');
    assert.equal(r.kind, 'invalid');
    assert.match(r.reason, /unclosed/);
});

test('scheduler: an invalid-format reply is retried once with the reason, then succeeds', async () => {
    const chatRef = { chat: [msg('g'), msg('u', { user: true }), msg('reply')] };
    setup(chatRef.chat);
    const h = makeAnalyzer(chatRef);
    const retries = [];
    let n = 0;
    h.analyzer.deps.analyze = (job, retry) => {
        retries.push(retry || null);
        return Promise.resolve(n++ === 0 ? '她推开了门。' : '<horae>\nlocation:教会\n</horae>');
    };
    h.analyzer.schedule(2);
    await h.analyzer.waitForIdle(1000);
    assert.equal(retries.length, 2);
    assert.equal(retries[0], null);
    assert.equal(retries[1].retry, 1);
    assert.match(retries[1].previousError, /no <horae>/);
    assert.equal(h.failures.length, 0);
    assert.equal(h.commits.length, 1);
    assert.ok(!h.states.includes('failed'));
});

test('scheduler: gives up after the retry budget and marks the message failed', async () => {
    const chatRef = { chat: [msg('g'), msg('u', { user: true }), msg('reply')] };
    const h = makeAnalyzer(chatRef);
    let calls = 0;
    h.analyzer.deps.analyze = () => { calls++; return Promise.resolve('<horae>\nlocation:被截'); };
    h.analyzer.schedule(2);
    await h.analyzer.waitForIdle(1000);
    assert.equal(calls, 2);
    assert.equal(h.failures.length, 1);
    assert.match(h.failures[0].reason, /unclosed/);
});

test('scheduler: a reply that turns stale during the retry is discarded', async () => {
    const chatRef = { chat: [msg('g'), msg('u', { user: true }), msg('reply')] };
    const h = makeAnalyzer(chatRef);
    let calls = 0;
    h.analyzer.deps.analyze = () => {
        calls++;
        if (calls === 2) chatRef.chat[2].mes = 'edited reply';
        return Promise.resolve(calls === 1 ? 'nope' : '<horae>\nlocation:教会\n</horae>');
    };
    h.analyzer.schedule(2);
    await h.analyzer.waitForIdle(1000);
    assert.equal(h.commits.length, 0);
    assert.equal(h.failures.length, 0);
    assert.ok(h.states.includes('stale'));
});

test('scheduler: waitForIdle times out instead of deadlocking', async () => {
    const chatRef = { chat: [msg('g'), msg('u', { user: true }), msg('reply')] };
    const h = makeAnalyzer(chatRef, { manual: true });
    h.analyzer.schedule(2);
    const t0 = Date.now();
    const ok = await h.analyzer.waitForIdle(50);
    assert.equal(ok, false);
    assert.ok(Date.now() - t0 < 1000);
    h.pending.get(chatRef.chat[2]).resolve('<horaenochange/>');
    assert.equal(await h.analyzer.waitForIdle(1000), true);
    // 不同聊天的等待不受影响
    assert.equal(await h.analyzer.waitForIdle(10, 'other-chat'), true);
});

// ---------- 主模型正文末尾的裸状态行（仅显示/发送层隐藏） ----------

test('state dump: trailing bare state lines are split off, prose kept intact', () => {
    const prose = '上官鹭的脚已经踩上了平衡梁的起点踏板。梁体在脚下第一次摆动，把她的重心推歪了三度。';
    const dump = [
        'time:2021/9/19 11:03',
        'location:第七学区·运动公园·A-3竞技场·平衡梁起点踏板',
        'atmosphere:竞速高潮与转播亢奋',
        'characters:上官鹭,御坂美琴',
        'costume:上官鹭=大会统一体操服＋过膝袜',
        'item:号码牌"4"(1)|A-3白组四道号码牌=上官鹭@已装备（胸前）',
        'affection:御坂美琴=+2（兴趣上升）',
        'mood:芦沢柚希=警觉',
        'npc:白组一道选手|短发＝胆怯@白组一道竞争对手~性别:女~年龄:18',
        'agenda:2021/9/19|第二障碍',
        'event:重要|上官鹭越过水墙',
        '',
        'event:重要|上官鹭越过水墙（简）',
    ].join('\n');
    const r = bg.splitTrailingStateDump(`"——喔！！"转播席的声音炸开。\n\n${prose}\n\n${dump}`);
    assert.ok(r.prose.endsWith(prose));
    assert.ok(r.dump.startsWith('time:2021/9/19 11:03'));
    assert.ok(r.dump.endsWith('（简）'));
});

test('state dump: tagged blocks, bars and RPG lines are recognized', () => {
    const r = bg.splitTrailingStateDump('正文。\n<horae>\ntime:1/1\nlocation:A\n</horae>\n<horaerpg>\nhp:尤丝蒂娜=84/100\nskill:尤丝蒂娜|强化|Lv1|x\n</horaerpg>');
    assert.equal(r.prose, '正文。');
});

test('state dump: prose and single stray lines are left alone', () => {
    for (const text of [
        '她说：“time: 这个词你懂吗？”\n然后离开了。',
        '正文第一段。\n\nlocation:某处',
        '正文。\nevent:重要|x\n然后她笑了。',
        'Note: the door is locked.\nStatus: unknown',
    ]) {
        const r = bg.splitTrailingStateDump(text);
        assert.equal(r.dump, '', text);
        assert.equal(r.prose, text);
    }
});
