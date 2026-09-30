import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStandingPromptMessages } from '../src/services/expressionStandingPrompt.js';
import { parseStandingPrompts, frameStandingPrompt, STANDING_COMPOSITION, STANDING_PREFIX } from '../src/services/expressionStandingPipeline.js';

const input = { systemRules: 'shared rules', slots: [{ id: 'normal', name: '正常' }, { id: 'emoji:42', name: '开心' }], persona: 'PERSONA_A', requirement: 'REQUEST_A' };

test('character and requirements changes preserve the entire reusable prompt prefix', () => {
  const a = buildStandingPromptMessages(input);
  const b = buildStandingPromptMessages({ ...input, persona: 'PERSONA_B', requirement: 'REQUEST_B' });
  assert.deepEqual(a.slice(0, 4), b.slice(0, 4));
  assert.equal(a[4].content, '角色人格与外观资料：\nPERSONA_A');
  assert.match(a[5].content, /REQUEST_A/);
  const c = buildStandingPromptMessages({ ...input, slots: input.slots.slice(0, 1) });
  assert.deepEqual(a.slice(0, 3), c.slice(0, 3));
});

test('complete slot example round trips emoji-style escaped identity and appearance tags', () => {
  const messages = buildStandingPromptMessages(input);
  const content = messages[3].content;
  const json = content.slice(content.indexOf('{'));
  const example = JSON.parse(json);
  assert.deepEqual(example.prompts.map(p => p.slotId), ['normal', 'emoji:42']);
  const sharedExample = JSON.parse(messages[2].content.slice(messages[2].content.indexOf('{')));
  assert.match(sharedExample.prompts[0].prompt, /Name \\\(Series\\\) \\\(/);
  const parsed = parseStandingPrompts(json, input.slots);
  assert.equal(parsed.get('normal'), `${STANDING_PREFIX}, ${example.prompts[0].prompt}`);
  assert.ok(messages[2].content.includes('不超过 80 个英文词'));
  assert.ok(messages[2].content.includes('不要重复输出'));
});

test('every prompt is framed with a leading solo before it reaches ComfyUI', () => {
  assert.ok(STANDING_PREFIX.startsWith('solo, '));
  // 生成链路：LLM 产出的标签串一律加前置
  const parsed = parseStandingPrompts(JSON.stringify({ prompts: [{ slotId: 'normal', prompt: 'Name \\(Series\\), gentle smile' }] }), [{ id: 'normal', name: '正常' }]);
  assert.equal(parsed.get('normal'), `solo, ${STANDING_COMPOSITION}, Name \\(Series\\), gentle smile`);
  // 手改 / 复用链路：没有前置的提示词补一份，已经带前置的不重复加
  assert.equal(frameStandingPrompt('1girl, blue eyes'), `${STANDING_PREFIX}, 1girl, blue eyes`);
  assert.equal(frameStandingPrompt(`${STANDING_PREFIX}, 1girl`), `${STANDING_PREFIX}, 1girl`);
  // 历史数据：老提示词开头那份不带 solo 的旧标签改写成新口径，而不是再前置一遍
  assert.equal(frameStandingPrompt(`${STANDING_COMPOSITION}, 1girl`), `${STANDING_PREFIX}, 1girl`);
  assert.equal(frameStandingPrompt(STANDING_COMPOSITION), STANDING_PREFIX);
});
