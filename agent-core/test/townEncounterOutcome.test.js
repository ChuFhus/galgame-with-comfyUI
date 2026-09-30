import { test } from 'node:test';
import assert from 'node:assert/strict';
const { settleEncounterOutcome, templateEncounterSummary, encounterScanRandom, parseEncounterOutcome,
  TOWN_ENCOUNTER_RULE_VERSION } = await import('../src/services/town/townEncounterOutcome.js');

const NOW = Date.parse('2026-09-30T09:00:00+08:00');

test('settleEncounterOutcome 按消息数/时长推导结果代码', () => {
  assert.equal(settleEncounterOutcome({ messageCount: 0, durationMs: 60_000, nowUtcMs: NOW }).resultCode, 'silent_pass');
  assert.equal(settleEncounterOutcome({ messageCount: 0, durationMs: 60_000, nowUtcMs: NOW }).interactionType, 'pass_by');
  // 有对话但很短/很少：brief_chat
  assert.equal(settleEncounterOutcome({ messageCount: 2, durationMs: 180_000, nowUtcMs: NOW }).resultCode, 'brief_chat');
  assert.equal(settleEncounterOutcome({ messageCount: 4, durationMs: 60_000, nowUtcMs: NOW }).resultCode, 'brief_chat');
  assert.equal(settleEncounterOutcome({ messageCount: 4, durationMs: 60_000, nowUtcMs: NOW }).interactionType, 'chat');
  // 足够长且有多条对话：chat
  assert.equal(settleEncounterOutcome({ messageCount: 4, durationMs: 180_000, nowUtcMs: NOW }).resultCode, 'chat');
  // 恢复路径可显式指定 interrupted
  const interrupted = settleEncounterOutcome({ messageCount: 0, resultCode: 'interrupted', nowUtcMs: NOW });
  assert.equal(interrupted.resultCode, 'interrupted');
  assert.equal(interrupted.interactionType, 'chat');
});

test('settleEncounterOutcome 携带规则版本与结算时刻且冻结', () => {
  const outcome = settleEncounterOutcome({ messageCount: 3, durationMs: 200_000, nowUtcMs: NOW });
  assert.equal(outcome.ruleVersion, TOWN_ENCOUNTER_RULE_VERSION);
  assert.ok(TOWN_ENCOUNTER_RULE_VERSION >= 1);
  assert.equal(outcome.settledAtUtcMs, NOW);
  assert.equal(Object.isFrozen(outcome), true);
  assert.throws(() => { outcome.resultCode = 'chat'; });
});

test('settleEncounterOutcome 拒绝非法输入', () => {
  assert.throws(() => settleEncounterOutcome({ messageCount: 0, nowUtcMs: 'x' }));
  assert.throws(() => settleEncounterOutcome({ messageCount: -1, nowUtcMs: NOW }));
  assert.throws(() => settleEncounterOutcome({ messageCount: 0, resultCode: 'made_up', nowUtcMs: NOW }));
});

test('encounterScanRandom 相同输入恒定、值域 [0,1)、不同输入发散', () => {
  const base = { seed: 'seed-1', mapId: 1, pair: 'npc:1|npc:2', bucket: 1000 };
  const a = encounterScanRandom(base);
  assert.equal(a, encounterScanRandom({ ...base }), '同一快照同一分钟桶判定必须可复现');
  assert.ok(a >= 0 && a < 1);
  // 不同对/不同桶/不同种子应产生不同值（抽样验证发散性）
  const others = [
    encounterScanRandom({ ...base, pair: 'npc:1|npc:3' }),
    encounterScanRandom({ ...base, bucket: 1001 }),
    encounterScanRandom({ ...base, seed: 'seed-2' }),
    encounterScanRandom({ ...base, mapId: 2 }),
  ];
  assert.equal(new Set([a, ...others]).size, 5, '不同输入应产生不同随机值');
  // 全值域抽样：1000 个桶的值应分布均匀（允许小样本波动）
  let above = 0;
  for (let b = 0; b < 1000; b++) if (encounterScanRandom({ ...base, bucket: b }) >= 0.5) above++;
  assert.ok(above > 400 && above < 600, `分布应接近均匀，实际 ${above}/1000`);
});

test('templateEncounterSummary 只由结果代码决定措辞', () => {
  const outcome = settleEncounterOutcome({ messageCount: 0, nowUtcMs: NOW });
  assert.equal(templateEncounterSummary({ outcome, nameA: '阿圆', nameB: '小林', locationName: '茶摊' }),
    '阿圆和小林在茶摊碰了个面，简单打了个照面。');
  const chat = settleEncounterOutcome({ messageCount: 4, durationMs: 200_000, nowUtcMs: NOW });
  assert.equal(templateEncounterSummary({ outcome: chat, nameA: '阿圆', nameB: '小林', locationName: '茶摊' }),
    '阿圆和小林在茶摊聊了一会儿天。');
  const interrupted = settleEncounterOutcome({ resultCode: 'interrupted', nowUtcMs: NOW });
  assert.equal(templateEncounterSummary({ outcome: interrupted, nameA: '阿圆', nameB: '小林', locationName: '茶摊' }),
    '阿圆和小林在茶摊的谈话被打断了。');
});

test('parseEncounterOutcome 接受合法结果、拒绝坏数据', () => {
  const outcome = settleEncounterOutcome({ messageCount: 2, durationMs: 100_000, nowUtcMs: NOW });
  assert.deepEqual(parseEncounterOutcome(JSON.stringify(outcome)), { ...outcome });
  assert.equal(parseEncounterOutcome(null), null);
  assert.equal(parseEncounterOutcome(''), null);
  assert.equal(parseEncounterOutcome('not json'), null);
  assert.equal(parseEncounterOutcome(JSON.stringify({ interactionType: 'chat', resultCode: 'made_up', ruleVersion: 1 })), null);
  assert.equal(parseEncounterOutcome(JSON.stringify({ interactionType: 'chat', resultCode: 'chat', ruleVersion: 0 })), null);
});
