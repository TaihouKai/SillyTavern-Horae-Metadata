/**
 * 世界书扫描文本：剧情日期展开成多种写法，让常见关键词都能命中。
 * 运行：node --test tests/lorebookScan.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLorebookScanText } from '../utils/timeUtils.js';
import { DEFAULT_BG_PROMPT_EN, DEFAULT_BG_PROMPT_ZH } from '../core/bgAnalysis.js';

test('a full date matches month keywords in slash, dash, Chinese and English forms', () => {
    const text = buildLorebookScanText({ story_date: '2020/1/10', story_time: '21:00', location: '学园都市·常盘台' });
    for (const key of ['2020/01', '2020/01/10', '2020-01', '2020年1月', '2020年1月10日', 'January 10, 2020', '21:00', '常盘台']) {
        assert.ok(text.includes(key), `missing ${key} in:\n${text}`);
    }
    assert.ok(!text.includes('2020/10'), 'January must not look like October');
});

test('Chinese-style and weekday-annotated dates are normalised too', () => {
    assert.ok(buildLorebookScanText({ story_date: '2020年1月10日' }).includes('2020/01/10'));
    assert.ok(buildLorebookScanText({ story_date: '2020/01/10 (五)' }).includes('2020/01/10'));
});

test('dates without a year and fictional calendars keep usable forms', () => {
    const short = buildLorebookScanText({ story_date: '1/10' });
    assert.ok(short.includes('01/10') && short.includes('1月10日'));
    const fantasy = buildLorebookScanText({ story_date: '霜月第三日' });
    assert.ok(fantasy.includes('霜月第三日'));
});

test('nothing to scan gives an empty string', () => {
    assert.equal(buildLorebookScanText({}), '');
    assert.equal(buildLorebookScanText({ story_date: '', story_time: '', location: '' }), '');
});

test('analyzer prompts ask for year/month/day calendar dates', () => {
    assert.ok(DEFAULT_BG_PROMPT_ZH.includes('2020/01/10'));
    assert.ok(DEFAULT_BG_PROMPT_EN.includes('2020/01/10'));
});
