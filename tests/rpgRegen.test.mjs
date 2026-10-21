/**
 * 属性条自动回复：按剧情时间推算，只改快照，不改楼层数据
 * 运行：node --test tests/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horaeManager, msg, setup, parse, commit } from './helpers.mjs';
import { storyElapsedMinutes, regenRates } from '../core/rpgRegen.js';

const U = '尤丝蒂娜';
const REGEN = { hp: { on: true, pct: 10 }, mp: { on: false, pct: 50 } };

/** 第 2 条受伤（HP 60、MP 20），第 4 条在 later 时间点 */
function chatWith(later, settings = { rpgRegen: REGEN }, laterRpg = '') {
    const chat = [msg('开场'), msg('出发。', { user: true }), msg('你受了伤。'), msg('休息。', { user: true }), msg('时间过去了。')];
    setup(chat, settings);
    commit(chat, 2, parse(`<horae>\ntime:2020/09/20 12:00\nlocation:学园都市\ncharacters:${U}\n</horae>\n<horaerpg>\nhp:${U}=60/100\nmp:${U}=20/100\n</horaerpg>`));
    commit(chat, 4, parse(`<horae>\ntime:${later}\nlocation:学园都市\ncharacters:${U}\n</horae>${laterRpg}`));
    return chat;
}

test('regen: elapsed minutes across days, same-day fallback and unknown times', () => {
    assert.equal(storyElapsedMinutes({ date: '2020/09/20', time: '12:00' }, { date: '2020/09/21', time: '08:30' }), 1230);
    assert.equal(storyElapsedMinutes({ date: '星历3年', time: '10:00' }, { date: '星历3年', time: '11:15' }), 75);
    assert.equal(storyElapsedMinutes({ date: '星历3年', time: '10:00' }, { date: '星历4年', time: '11:15' }), null);
    assert.equal(storyElapsedMinutes({ date: '2020/09/20', time: '傍晚' }, { date: '2020/09/20', time: '20:00' }), null);
    assert.deepEqual([...regenRates(REGEN)], [['hp', 0.1]]);
});

test('regen: restores pct of max per story hour, only for enabled bars', () => {
    const chat = chatWith('2020/09/20 14:30');
    const rpg = horaeManager.getRpgStateAt(0);
    assert.deepEqual(rpg.bars[U].hp.slice(0, 2), [85, 100], '60 + 10%×2.5h');
    assert.deepEqual(rpg.bars[U].mp.slice(0, 2), [20, 100], 'mp is off');
    assert.deepEqual(chat[2].horae_meta._rpgChanges.bars[U].hp.slice(0, 2), [60, 100], 'message data unchanged');
    // 截到第 2 条为止的快照（发送第 3 条时）还没有经过时间
    assert.equal(horaeManager.getRpgStateAt(2).bars[U].hp[0], 60);
});

test('regen: capped at max; a newly written value restarts the count', () => {
    chatWith('2020/09/21 08:00');
    assert.equal(horaeManager.getRpgStateAt(0).bars[U].hp[0], 100);

    chatWith('2020/09/20 13:00', { rpgRegen: REGEN }, `\n<horaerpg>\nhp:${U}=50/100\n</horaerpg>`);
    assert.equal(horaeManager.getRpgStateAt(0).bars[U].hp[0], 50, 'written at 13:00, no time has passed since');
});

test('regen: off, rpg mode off, or time going backwards changes nothing', () => {
    chatWith('2020/09/20 18:00', { rpgRegen: {} });
    assert.equal(horaeManager.getRpgStateAt(0).bars[U].hp[0], 60);
    chatWith('2020/09/20 18:00', { rpgRegen: { hp: { on: true, pct: 0 } } });
    assert.equal(horaeManager.getRpgStateAt(0).bars[U].hp[0], 60);
    chatWith('2020/09/20 18:00', { rpgRegen: REGEN, rpgMode: false });
    assert.equal(horaeManager.getRpgStateAt(0).bars[U].hp?.[0] ?? 60, 60);
    chatWith('2020/09/20 09:00');
    assert.equal(horaeManager.getRpgStateAt(0).bars[U].hp[0], 60);
});

test('regen: the main-model context shows the regenerated value', () => {
    chatWith('2020/09/20 14:30');
    const prompt = horaeManager.generateCompactPrompt(0);
    assert.match(prompt, /85\/100/);
    assert.doesNotMatch(prompt, /60\/100/);
});
