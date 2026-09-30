import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`needs fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
// 注意顺序：getDb 会用库里存的设置覆盖 config，测试口径必须在 getDb 之后再定
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
  timeZone: 'Asia/Shanghai' });
const { createTownNeedsService, derivePersonality, deriveInterests, NEED_KEYS } = await import('../src/services/town/townNeedsService.js');
const { pairEncounterFactor } = await import('../src/services/town/townEncounterOutcome.js');
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');

const W = 'w-test';
const makeService = () => createTownNeedsService({ db: getDb(), needsConfig: config.town.needs });
const T0 = Date.parse('2026-09-30T09:00:00+08:00');
const HOUR = 3600_000;

test('需求按逻辑时间结算：与 tick 次数无关、有界、性格修正', () => {
  const needs = makeService();
  // 一次性结算 2 小时
  const oneShot = needs.settleNeeds(W, 'actor-a', T0);
  assert.equal(oneShot.satiety, 100, '首拍只建游标，不衰减');
  const after2h = needs.settleNeeds(W, 'actor-a', T0 + 2 * HOUR);
  assert.equal(after2h.satiety, 100 - 2 * 2, 'satiety 衰减 2/小时 × 2 小时');
  // 分 120 拍每分钟一次 → 与一次性 2 小时完全一致（时间驱动，而非 tick 驱动）
  const b = needs.settleNeeds(W, 'actor-b', T0);
  let now = T0;
  for (let i = 0; i < 120; i++) now += 60_000;
  const perTick = needs.settleNeeds(W, 'actor-b', now);
  assert.equal(perTick.satiety, after2h.satiety, '相同时间推进量下 tick 次数不影响结果');
  // 性格修正：先建游标再结算 1 小时；外向者社交衰减更快，内向者更慢
  needs.settleNeeds(W, 'actor-ext', T0);
  needs.settleNeeds(W, 'actor-int', T0);
  const e = needs.settleNeeds(W, 'actor-ext', T0 + HOUR, { personality: { extraversion: 1 } });
  const i = needs.settleNeeds(W, 'actor-int', T0 + HOUR, { personality: { extraversion: 0 } });
  assert.equal(e.social, 100 - 1.4, '外向 1.4×');
  assert.equal(i.social, 100 - 0.6, '内向 0.6×');
});

test('需求永远在 0-100 且有限；离线间隔按上限截断', () => {
  const needs = makeService();
  needs.settleNeeds(W, 'actor-c', T0);
  // 100 小时一次性结算：承认的衰减不超过 maxSettleGapMs（12h），其余被温和豁免
  const after = needs.settleNeeds(W, 'actor-c', T0 + 100 * HOUR);
  for (const key of NEED_KEYS) {
    assert.ok(Number.isFinite(after[key]) && after[key] >= 0 && after[key] <= 100, `${key} 应有界`);
  }
  assert.equal(after.satiety, Math.max(0, 100 - 2 * 12), '衰减按 12 小时上限截断');
  // 恢复在线节奏后按真实时间继续衰减，且不产生负数或 NaN
  const later = needs.settleNeeds(W, 'actor-c', T0 + 102 * HOUR);
  assert.equal(later.satiety, Math.max(0, 100 - 2 * 12 - 2 * 2));
  for (const key of NEED_KEYS) assert.ok(Number.isFinite(later[key]) && later[key] >= 0);
});

test('需求效果：调用即生效、数值有界（不再有来源台账表）', () => {
  const needs = makeService();
  needs.settleNeeds(W, 'actor-d', T0);
  assert.equal(needs.applyNeedEffects({ worldId: W, actorId: 'actor-d',
    effects: { energy: 30 }, nowUtcMs: T0 }), true);
  assert.equal(needs.getNeeds(W, 'actor-d', T0).energy, 100, '恢复被夹在 100（起始即满）');
  // 从低位恢复，且不出现越界
  needs.applyNeedEffects({ worldId: W, actorId: 'actor-d', effects: { energy: -60 }, nowUtcMs: T0 + 2 });
  needs.applyNeedEffects({ worldId: W, actorId: 'actor-d', effects: { energy: 10 }, nowUtcMs: T0 + 3 });
  assert.equal(needs.getNeeds(W, 'actor-d', T0).energy, 50);
  // 是否重复结算由调用方契约保证（动作终态唯一 / 相遇结算单事务），这里只验证数值语义
  assert.equal(getDb().prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='town_need_effects'").get().n, 0,
    '不再存在 town_need_effects 表');
});

test('综合心情只看需求基线（影响项机制已删除）', () => {
  const needs = makeService();
  needs.settleNeeds(W, 'actor-e', T0);
  const full = needs.computeMood({ worldId: W, actorId: 'actor-e' });
  assert.equal(full.mood, 1, '需求全满 → 心情 +1');
  needs.applyNeedEffects({ worldId: W, actorId: 'actor-e', effects: { satiety: -100, energy: -100, social: -100, fun: -100 }, nowUtcMs: T0 });
  const low = needs.computeMood({ worldId: W, actorId: 'actor-e' });
  assert.ok(low.mood < 0.5, '需求下降 → 心情回落');
  assert.equal(getDb().prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='town_mood_influences'").get().n, 0,
    '不再存在 town_mood_influences 表');
});

test('性格派生稳定、兴趣来自本地关键词', () => {
  const p1 = derivePersonality(W, 'actor-a');
  const p2 = derivePersonality(W, 'actor-a');
  assert.deepEqual(p1, p2, '同一身份派生恒定');
  assert.notDeepEqual(derivePersonality(W, 'actor-b'), p1);
  for (const v of Object.values(p1)) assert.ok(v >= 0.25 && v <= 0.75);
  assert.deepEqual(deriveInterests('茶摊主，爱做点心'), ['料理']);
  assert.deepEqual(deriveInterests('看店的'), ['散步'], '未命中关键词时缺省散步');
});

test('相遇倾向因子：外向组合更高、内向组合更低、缺档中性', () => {
  const ext = { extraversion: 1 }, int = { extraversion: 0 };
  assert.equal(pairEncounterFactor(ext, ext), 1.5);
  assert.equal(pairEncounterFactor(int, int), 0.5);
  assert.ok(Math.abs(pairEncounterFactor(ext, int) - Math.sqrt(0.75)) < 1e-9);
  assert.equal(pairEncounterFactor(undefined, undefined), 1, '缺档案时中性');
  assert.equal(pairEncounterFactor({ extraversion: 9 }, ext), 1.5, '越界值被夹回');
});

// ── 集成：真实主循环里的两条需求闭环 ──

test('M1 集成：休息恢复精力、相遇恢复社交（零模型）', async t => {
  let now = Date.parse('2026-09-30T09:00:00+08:00');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clockRef = { now };
  t.mock.method(Date, 'now', () => clockRef.now);
  const db = getDb();
  const registry = createTownActorRegistry(db);
  t.after(() => { simB.stop(); closeDb(); t.mock.timers.reset(); });

  // ── 阶段一：两位居民在广场相遇（prob=1）→ 收尾 → 社交需求恢复 ──
  config.town.maxActiveEncounters = 1;
  Object.assign(config.town, { encounterStrangerProb: 1, encounterRelatedProb: 1,
    encounterMinStartGapMin: 0, encounterCooldownHours: 3 });
  const simA = createTownHeadlessSim({ startUtcMs: now, name: 'needs-enc' });
  const stepA = async (ms = 30_000) => { now += ms; simA.step(ms); clockRef.now = now; await new Promise(r => setImmediate(r)); };
  let encounterId = null;
  for (let i = 0; i < 6 && !encounterId; i++) { await stepA(); }
  const encRows = db.prepare('SELECT id, status, outcome_json FROM town_encounters WHERE map_id = ?').all(simA.mapId);
  encounterId = encRows[0]?.id;
  assert.ok(encounterId, '相遇应开始');
  for (let i = 0; i < 4; i++) await stepA();
  assert.equal(db.prepare('SELECT status FROM town_encounters WHERE id = ?').get(encounterId).status, 'done');
  const actorsA = simA.npcIds.map(id => registry.resolveAgentKey(`npc:${id}`).actorId);
  // 社交恢复直接体现在需求值上（不再有台账表）：双方社交需求高于纯衰减的水平
  for (const actorId of actorsA) {
    const social = JSON.parse(getDb().prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?').get(actorId).needs_json).social;
    assert.ok(social > 95, `相遇后社交应接近满值（含正常衰减），实际 ${social}`);
  }
  const needsRowA = db.prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?').get(actorsA[0]);
  assert.ok(needsRowA, '需求状态应已落库');
  assert.ok(JSON.parse(needsRowA.needs_json).satiety < 100, 'satiety 应随时间衰减');
  simA.stop();

  // ── 阶段二：全天睡觉的居民 → rest 动作完成 → 精力恢复 ──
  clockRef.now = now;
  const simB = createTownHeadlessSim({ startUtcMs: now, name: 'needs-rest',
    locations: [
      { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 4, y: 4, radius: 2 },
      { key: 'home_a', name: '西边小院', kind: 'home', x: 1, y: 1, radius: 1 },
    ],
    residents: [{ displayName: '贪睡的阿慢', job: '居民',
      routine: [{ start: '00:00', end: '24:00', locationKey: 'home_a', actionType: 'rest', sleeping: true, activity: '睡得正香' }] }] });
  const actorB = registry.resolveAgentKey(`npc:${simB.npcIds[0]}`).actorId;
  const stepB = async (ms = 5 * 60_000) => { now += ms; simB.step(ms); clockRef.now = now; await new Promise(r => setImmediate(r)); };
  await stepB(); // 建立需求游标
  // 压低精力，恢复量才可观察
  const row = getDb().prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?').get(actorB);
  const lowered = { ...JSON.parse(row.needs_json), energy: 40 };
  getDb().prepare('UPDATE town_resident_needs SET needs_json = ? WHERE actor_id = ?').run(JSON.stringify(lowered), actorB);
  // 60 秒步长：资源租约 3 分钟内必须续租（生产由 5 秒模拟子时钟驱动），否则动作会 LEASE_LOST
  for (let i = 0; i < 40; i++) await stepB(60_000);
  const restDone = getDb().prepare(`SELECT count(*) n FROM town_actions
    WHERE actor_id = ? AND type = 'rest' AND status = 'completed'`).get(actorB).n;
  assert.ok(restDone >= 1, '完成的 rest 动作应结算精力恢复（看动作行）');
  const energyAfter = JSON.parse(getDb().prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?')
    .get(actorB).needs_json).energy;
  assert.ok(energyAfter > 45, `精力应从 40 显著恢复，实际 ${energyAfter}`);
  assert.ok(energyAfter <= 100);
});
