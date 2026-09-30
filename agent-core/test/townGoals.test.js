import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`goals fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
  timeZone: 'Asia/Shanghai' });
const { createTownGoalService } = await import('../src/services/town/townGoalService.js');
const { pickIdleLifeAction } = await import('../src/services/town/townDecisionService.js');

const CFG = config.town.goals;
const T0 = Date.parse('2026-09-30T10:00:00+08:00');
const DAY = Math.floor(T0 / 86400000);
const W = 'w-goals';
const makeService = () => createTownGoalService({ db: getDb(), goalConfig: CFG });
const PROFILE = { interests: ['阅读', '料理'], personality: { curiosity: 0.5 } };

test('目标挑选：三槽位确定性在册，无工作地点不挑职业目标，当日不重选', () => {
  const goals = makeService();
  const first = goals.ensureGoals({ worldId: W, actorId: 'a1', profile: PROFILE,
    context: { hasWorkplace: false }, localDay: DAY, nowUtcMs: T0 });
  assert.equal(first.length, 3, '主目标 + 两个愿望');
  assert.ok(first.every(g => g.status === 'active'));
  assert.ok(!first.some(g => g.type === 'career'), '无工作地点不生成职业目标');
  assert.ok(first.some(g => g.type === 'interest_read' || g.type === 'interest_eat'), '愿望优先兴趣');
  // 同一日重复调用不重选（游标）
  const again = goals.ensureGoals({ worldId: W, actorId: 'a1', profile: PROFILE,
    context: { hasWorkplace: false }, localDay: DAY, nowUtcMs: T0 + 1 });
  assert.deepEqual(again.map(g => [g.slot, g.type, g.progress]), first.map(g => [g.slot, g.type, g.progress]));
  // 次日：进行中的目标保留（不重置进度）
  goals.applyProgress({ worldId: W, actorId: 'a1', sourceKey: 'enc:1', kind: 'social', amount: 5,
    nowUtcMs: T0, localDay: DAY });
  const nextDay = goals.ensureGoals({ worldId: W, actorId: 'a1', profile: PROFILE,
    context: { hasWorkplace: false }, localDay: DAY + 1, nowUtcMs: T0 + 86400000 });
  const social = nextDay.find(g => g.type === 'social');
  assert.ok(social && social.progress >= 5, '进行中目标跨日保留进度');
});

test('目标进度从已结算事实消费：完成即停、来源不重复计入、受阻替换', () => {
  const goals = makeService();
  goals.ensureGoals({ worldId: W, actorId: 'b1', profile: PROFILE,
    context: { hasWorkplace: true }, localDay: DAY, nowUtcMs: T0 });
  const before = goals.getActiveGoals(W, 'b1').find(g => g.type === 'career');
  assert.ok(before, '有工作地点应有职业目标');
  // 工作推进：来源键幂等
  goals.applyProgress({ worldId: W, actorId: 'b1', sourceKey: 'work_shift:a1', kind: 'work', amount: 1,
    nowUtcMs: T0, localDay: DAY });
  goals.applyProgress({ worldId: W, actorId: 'b1', sourceKey: 'work_shift:a1', kind: 'work', amount: 1,
    nowUtcMs: T0 + 1, localDay: DAY });
  const after = goals.getActiveGoals(W, 'b1').find(g => g.type === 'career');
  assert.equal(after.progress, CFG.careerProgressPerShift, '同一来源不重复计入');
  // 推进到完成（7 次 × 5 ≥ 目标 30）
  for (let k = 2; k <= 7; k++) {
    goals.applyProgress({ worldId: W, actorId: 'b1', sourceKey: `work_shift:a${k}`, kind: 'work', amount: 1,
      nowUtcMs: T0 + k, localDay: DAY });
  }
  const doneRow = getDb().prepare(`SELECT status, progress FROM town_resident_goals
    WHERE world_id = ? AND actor_id = ? AND slot = 0`).get(W, 'b1');
  assert.equal(doneRow.status, 'completed', '进度达标即完成');
  assert.equal(doneRow.progress, 30);
  // 完成后不再重复结算奖励：继续同一 kind 的进度不影响已完成目标
  goals.applyProgress({ worldId: W, actorId: 'b1', sourceKey: 'work_shift:after', kind: 'work', amount: 1,
    nowUtcMs: T0 + 90000000, localDay: DAY });
  assert.equal(getDb().prepare(`SELECT progress FROM town_resident_goals
    WHERE world_id = ? AND actor_id = ? AND slot = 0`).get(W, 'b1').progress, 30, '完成后进度冻结');
  // 次日评估：完成槽位换新目标（新目标 active、进度从 0 开始）
  const all = goals.ensureGoals({ worldId: W, actorId: 'b1', profile: PROFILE,
    context: { hasWorkplace: true }, localDay: DAY + 1, nowUtcMs: T0 + 86400000 });
  const slot0 = all.find(g => g.slot === 0);
  assert.equal(slot0.status, 'active', '次日完成槽位换新目标');
  assert.equal(slot0.progress, 0);
});

test('技能与习惯：每日收益有上限、边际递减、等级有界', () => {
  const goals = makeService();
  for (let k = 0; k < 50; k++) {
    goals.applyProgress({ worldId: W, actorId: 'c1', sourceKey: `work_shift:${k}`, kind: 'work', amount: 1,
      nowUtcMs: T0 + k * 60000, localDay: DAY });
  }
  const row = getDb().prepare(`SELECT level, daily_gain FROM town_resident_skills
    WHERE world_id = ? AND actor_id = ? AND key = 'service'`).get(W, 'c1');
  assert.ok(row, 'service 技能应在册');
  assert.ok(row.level > 0 && row.level <= 100, '等级有界');
  assert.ok(row.daily_gain <= CFG.skillDailyCap + 0.001, `每日收益不超过上限（${row.daily_gain}）`);
  assert.ok(row.level < 50 * CFG.skillBase, '等级受每日上限与边际递减约束，不线性暴涨');
});

test('工资推进攒钱目标；决策偏置把兴趣目标接到生活动作评分', () => {
  const goals = makeService();
  goals.ensureGoals({ worldId: W, actorId: 'd1', profile: PROFILE,
    context: { hasWorkplace: false }, localDay: DAY, nowUtcMs: T0 });
  for (let k = 0; k < 20; k++) {
    goals.applyProgress({ worldId: W, actorId: 'd1', sourceKey: `wage:${k}`, kind: 'wage', amount: 10,
      nowUtcMs: T0 + k, localDay: DAY });
  }
  const life = goals.getActiveGoals(W, 'd1').find(g => g.type === 'life');
  assert.ok(!life || life.status === 'completed', '攒钱目标达标后完成');
  const bias = goals.getDecisionBias(W, 'd1');
  assert.ok(bias.read > 0 || bias.eat > 0, '兴趣目标产生生活动作评分加成');

  // 决策层：带偏置的阅读分数更高（fun 低时阅读候选出现）
  const venues = [{ key: 'study', offers: ['read', 'sit'], x: 2, y: 2 }];
  const base = pickIdleLifeAction({ needs: { satiety: 100, energy: 100, social: 100, fun: 55, comfort: 100, security: 100 },
    venues, position: { x: 4, y: 4 }, config: config.town.life, nowUtcMs: T0, actorId: 'npc:1' });
  const biased = pickIdleLifeAction({ needs: { satiety: 100, energy: 100, social: 100, fun: 55, comfort: 100, security: 100 },
    venues, position: { x: 4, y: 4 }, config: config.town.life, nowUtcMs: T0, actorId: 'npc:1',
    goalBias: { read: CFG.interestGoalBonus } });
  assert.equal(base.action, 'read');
  assert.ok(biased.score > base.score, '目标偏置提升阅读评分');
});
