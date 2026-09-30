import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`narrative fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
const { createTownNarrativeService } = await import('../src/services/town/townNarrativeService.js');

const CFG = { ...config.town.narrative };
const T0 = Date.parse('2026-09-30T10:00:00+08:00');
const SPEAKERS = [{ actorId: 'npc:1', displayName: '阿圆' }, { actorId: 'npc:2', displayName: '小林' }];
const CHOICES = [{ choiceId: 'help', intent: '帮忙备料', fallbackLabel: '帮忙备料' }];
const FACTS = { sourceEventId: 'evt-1', text: '阿圆的饭馆食材见底了，她想请邻居帮忙想想办法。',
  fallbackSummary: '阿圆的饭馆食材见底了，她在想办法补货。',
  fallbackLine: '这批食材用完了，可怎么办呀。' };
const makeService = (over = {}) => createTownNarrativeService({ narrativeConfig: { ...CFG, ...over } });

const validPayload = {
  sourceEventId: 'evt-1',
  summary: '阿圆的饭馆食材见了底，她正想着法子找邻居帮忙补上缺口。',
  lines: [{ speakerActorId: 'npc:1', text: '这批食材用完了，可怎么办呀，愁死我了。' }],
  choices: [{ choiceId: 'help', label: '帮忙想想办法' }],
};
const okChat = JSON.stringify(validPayload);

test('契约校验：合法输出通过，违规输出全部拒绝', () => {
  const service = makeService();
  const ctx = { sourceEventId: 'evt-1', allowedSpeakers: SPEAKERS, choices: CHOICES };
  assert.ok(service.validateModelOutput(JSON.parse(okChat), ctx), '合法输出应通过');
  // 额外字段
  assert.equal(service.validateModelOutput({ ...validPayload, extra: 1 }, ctx), null);
  // 来源不匹配
  assert.equal(service.validateModelOutput({ ...validPayload, sourceEventId: 'evt-2' }, ctx), null);
  // 未知发言身份
  assert.equal(service.validateModelOutput({ ...validPayload,
    lines: [{ speakerActorId: 'npc:9', text: '这句台词来自一个不存在的人物。' }] }, ctx), null);
  // 未知选项 / 重复选项
  assert.equal(service.validateModelOutput({ ...validPayload,
    choices: [{ choiceId: 'rob', label: '直接抢走食材' }] }, ctx), null);
  assert.equal(service.validateModelOutput({ ...validPayload,
    choices: [CHOICES[0], CHOICES[0]].map(c => ({ choiceId: c.choiceId, label: '帮忙想想办法' })) }, ctx), null);
  // 超长/过短文本
  assert.equal(service.validateModelOutput({ ...validPayload, summary: '太短' }, ctx), null);
  assert.equal(service.validateModelOutput({ ...validPayload,
    lines: [{ speakerActorId: 'npc:1', text: '短' }] }, ctx), null);
  // 台词条数越界
  assert.equal(service.validateModelOutput({ ...validPayload,
    lines: Array.from({ length: 7 }, () => ({ speakerActorId: 'npc:1', text: '这是一条用来触顶的台词内容。' })) }, ctx), null);
  // 无选项时必须输出空数组
  const noChoiceCtx = { sourceEventId: 'evt-1', allowedSpeakers: SPEAKERS, choices: [] };
  assert.ok(service.validateModelOutput({ ...validPayload, choices: [] }, noChoiceCtx));
  assert.equal(service.validateModelOutput(validPayload, noChoiceCtx), null);
});

test('模板回退：零模型、模型输出违规、重试耗尽都不编造事实', async () => {
  // 零模型：直接模板
  const plain = makeService();
  const zero = await plain.narrate({ sourceEventId: 'evt-1', factsVersion: 1, facts: FACTS,
    allowedSpeakers: SPEAKERS, choices: CHOICES, worldId: 'w', nowUtcMs: T0 });
  assert.equal(zero.source, 'template');
  assert.equal(zero.narrative.summary, FACTS.fallbackSummary);
  assert.equal(zero.narrative.lines[0].speakerActorId, 'npc:1');
  assert.equal(zero.narrative.choices[0].choiceId, 'help');
  // 模型输出违规 → 回退
  const bad = makeService();
  let calls = 0;
  const badResult = await bad.narrate({ sourceEventId: 'evt-1', factsVersion: 1, facts: FACTS,
    allowedSpeakers: SPEAKERS, choices: CHOICES, worldId: 'w', nowUtcMs: T0,
    chatSync: async () => { calls++; return JSON.stringify({ ...validPayload, sourceEventId: '伪造' }); } });
  assert.equal(badResult.source, 'template', '违规输出回退模板');
  assert.equal(calls, CFG.maxAttempts, '失败只允许有限重试');
});

test('缓存与预算：重复打开不重新生成；自动叙事受每日额度约束；手动不计预算', async () => {
  const service = makeService({ dailyAutoQuota: 2 });
  let calls = 0;
  const chat = async msgs => {
    calls++;
    const match = /【事件 ID】(\S+)/.exec(msgs[0].content);
    return JSON.stringify({ ...validPayload, sourceEventId: match ? match[1] : 'evt-1' });
  };
  const base = { sourceEventId: 'evt-1', factsVersion: 1, facts: FACTS, allowedSpeakers: SPEAKERS,
    choices: CHOICES, worldId: 'w', nowUtcMs: T0, chatSync: chat };
  const first = await service.narrate(base);
  const second = await service.narrate(base);
  assert.equal(first.source, 'model');
  assert.equal(calls, 1, '缓存命中不重新生成');
  assert.equal(second.narrative.summary, first.narrative.summary);
  // 事实版本变化 → 新缓存键 → 重新生成
  await service.narrate({ ...base, factsVersion: 2 });
  assert.equal(calls, 2);
  // 预算：auto 第 3 次（quota 2）走模板且不调模型
  const third = await service.narrate({ ...base, sourceEventId: 'evt-3' });
  assert.equal(third.source, 'template', '超出每日预算回退模板');
  assert.equal(calls, 2);
  // 次日预算恢复
  await service.narrate({ ...base, sourceEventId: 'evt-4', nowUtcMs: T0 + 86400000 });
  assert.equal(calls, 3);
  // 手动触发不计预算
  const manual = await service.narrate({ ...base, sourceEventId: 'evt-5', mode: 'manual' });
  assert.equal(manual.source, 'model', '手动触发不受自动预算约束');
});

test('提示词骨架逐字来自 §6.8 并携带事实与允许项', () => {
  const service = makeService();
  const prompt = service.buildPrompt({ sourceEventId: 'evt-1', facts: FACTS, allowedSpeakers: SPEAKERS, choices: CHOICES });
  assert.ok(prompt.includes('严格按以下示例格式输出 JSON，不要输出解释、Markdown 代码围栏或 JSON 以外的文字。'));
  assert.ok(prompt.includes('不得新增已完成的交易、承诺、人物身份、道具或数值结果。'));
  assert.ok(prompt.includes('不得增加字段。sourceEventId 必须与本次输入一致。'));
  assert.ok(prompt.includes('【事件 ID】evt-1'));
  assert.ok(prompt.includes(FACTS.text));
  assert.ok(prompt.includes('npc:1'));
  assert.ok(prompt.includes('help'));
});
