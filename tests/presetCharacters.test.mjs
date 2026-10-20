/**
 * 预设角色：按名字/别名覆盖聚合后的角色档案，不改楼层数据
 * 运行：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horaeManager, msg, setup, parse, commit } from './helpers.mjs';
import { parsePresetCharacters } from '../core/presetCharacters.js';

const PRESET = [
    '# 注释行会被忽略',
    '食蜂操祈|金色长发，星形瞳孔=傲娇腹黑~性别:女~年龄:14~职业:超能力者第五位~别名:食蜂/女王',
    'npc:御坂美琴|茶色短发=好强@朋友',
].join('\n');

function chatWithMisaki(name = '食蜂操祈') {
    const chat = [msg('开场'), msg('走进学园都市。', { user: true }), msg('一位金发少女向你走来。')];
    setup(chat, { presetCharacters: { enabled: true, text: PRESET } });
    commit(chat, 2, parse(`<horae>\nnpc:${name}|金发少女=温柔@刚认识的同学~性别:女~年龄:16~种族:人类\n</horae>`));
    return chat;
}

test('preset: parses npc-format lines, aliases, optional npc: prefix and comments', () => {
    const p = parsePresetCharacters(PRESET, (s) => horaeManager._parseNpcFields(s));
    assert.deepEqual(p.map(x => x.name), ['食蜂操祈', '御坂美琴']);
    assert.deepEqual(p[0].aliases, ['食蜂', '女王']);
    assert.equal(p[0].fields.appearance, '金色长发，星形瞳孔');
    assert.equal(p[0].fields.job, '超能力者第五位');
    assert.equal(p[0].fields.relationship, undefined);
    assert.equal(p[1].fields.relationship, '朋友');
});

test('preset: replaces the whole profile; fields left out are empty', () => {
    const chat = chatWithMisaki();
    const npc = horaeManager.getLatestState().npcs['食蜂操祈'];
    assert.equal(npc.appearance, '金色长发，星形瞳孔');
    assert.equal(npc.personality, '傲娇腹黑');
    assert.equal(npc.age, '14');
    assert.equal(npc.relationship, '', 'relationship not in preset → empty, not the AI value');
    assert.equal(npc.race, '', 'race not in preset → empty');
    assert.equal(npc._preset, '食蜂操祈');
    // 楼层里的原始记录不变
    assert.equal(chat[2].horae_meta.npcs['食蜂操祈'].appearance, '金发少女');
});

test('preset: matches by preset alias', () => {
    chatWithMisaki('食蜂');
    const npc = horaeManager.getLatestState().npcs['食蜂'];
    assert.equal(npc.personality, '傲娇腹黑');
});

test('preset: later AI updates do not win over the preset', () => {
    const chat = chatWithMisaki();
    chat.push(msg('继续。', { user: true }), msg('她笑了。'));
    commit(chat, 4, parse('<horae>\nnpc:食蜂操祈|金发少女=阴险@盟友\n</horae>'));
    const npc = horaeManager.getLatestState().npcs['食蜂操祈'];
    assert.equal(npc.personality, '傲娇腹黑');
    assert.equal(npc.appearance, '金色长发，星形瞳孔');
    assert.equal(npc.relationship, '');
});

test('preset: disabled or unmatched leaves the AI profile untouched', () => {
    chatWithMisaki();
    horaeManager.settings.presetCharacters.enabled = false;
    const npc = horaeManager.getLatestState().npcs['食蜂操祈'];
    assert.equal(npc.appearance, '金发少女');
    assert.equal(npc._preset, undefined);
    horaeManager.settings.presetCharacters = { enabled: true, text: '白井黑子|双马尾' };
    assert.equal(horaeManager.getLatestState().npcs['食蜂操祈'].appearance, '金发少女');
});

test('preset: does not create characters the AI has not recorded', () => {
    chatWithMisaki();
    assert.equal(horaeManager.getLatestState().npcs['御坂美琴'], undefined);
});
