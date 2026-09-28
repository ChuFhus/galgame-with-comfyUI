import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStandingPromptMessages } from '../src/services/expressionStandingPrompt.js';
import { parseStandingPrompts, STANDING_PREFIX } from '../src/services/expressionStandingPipeline.js';

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
