import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`decision fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
  timeZone: 'Asia/Shanghai' });
const { pickIdleLifeAction } = await import('../src/services/town/townDecisionService.js');
const { listLifeVenues } = await import('../src/services/town/townAffordanceService.js');
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');

const T0 = Date.parse('2026-09-30T10:00:00+08:00');
const cfg = config.town.life;
const POS = { x: 4, y: 4 };
const FULL = { satiety: 100, energy: 100, social: 100, fun: 100, comfort: 100, security: 100 };

const venues = [
  { key: 'tavern_far', offers: ['eat'], x: 10, y: 10 },
  { key: 'tavern_near', offers: ['eat'], x: 5, y: 5 },
  { key: 'study', offers: ['read', 'sit'], x: 2, y: 2 },
  { key: 'plaza', offers: ['sit'], x: 6, y: 6 },
];

const decide = over => pickIdleLifeAction({
  needs: FULL, venues, position: POS, config: cfg, nowUtcMs: T0, actorId: 'npc:1', ...over });

test('饥饿提升吃饭候选吸引力：分数随饱食降低而上升', () => {
  const hungry = decide({ needs: { ...FULL, satiety: 30 } });
  const mild = decide({ needs: { ...FULL, satiety: 60 } });
  assert.equal(hungry.action, 'eat');
  assert.equal(mild.action, 'eat');
  assert.ok(hungry.score > mild.score, '越饿吃饭分数越高');
  assert.equal(hungry.target, 'tavern_near', '就近场所胜出（距离成本）');
  // 诊断：候选列表带分数，可解释淘汰理由
  assert.ok(Array.isArray(hungry.candidates) && hungry.candidates.length >= 1);
  assert.ok(hungry.candidates.every(c => Number.isFinite(c.score)));
});

test('饱食充足不吃饭；疲惫/不适产生落座候选；无聊产生阅读候选', () => {
  assert.equal(decide({ needs: { ...FULL, satiety: 90 } }), null, '全部满足时无生活动作（satiety 90 > 阈值）');
  const tired = decide({ needs: { ...FULL, energy: 30 } });
  assert.equal(tired.action, 'sit', '疲惫提高休息吸引力');
  const bored = decide({ needs: { ...FULL, fun: 40 } });
  assert.equal(bored.action, 'read', '娱乐低产生阅读');
});

test('性格与兴趣改变选择：好奇心增强阅读，料理兴趣增强吃饭', () => {
  const base = decide({ needs: { ...FULL, fun: 55, satiety: 66 }, personality: { curiosity: 0 } });
  const curious = decide({ needs: { ...FULL, fun: 55, satiety: 66 }, personality: { curiosity: 1 } });
  assert.equal(base.action, 'read');
  assert.ok(curious.score > base.score, '好奇心提升阅读分');
  // 料理兴趣：恰好在 eat 阈值边缘时把吃饭推成候选
  const withInterest = decide({ needs: { ...FULL, satiety: 64 }, interests: ['料理'] });
  const withoutInterest = decide({ needs: { ...FULL, satiety: 64 } });
  if (withoutInterest) assert.ok(withInterest.score >= withoutInterest.score);
  assert.equal(withInterest.action, 'eat');
});

test('滞回：计划保留至需求恢复出带，带退出后重新决策', () => {
  const current = { action: 'eat', target: 'tavern_near' };
  const kept = decide({ needs: { ...FULL, satiety: 70 }, current });
  assert.deepEqual({ action: kept.action, target: kept.target }, current, '带内保留现计划');
  assert.equal(kept.score, null, '滞回保留不重算分数');
  const fresh = decide({ needs: { ...FULL, satiety: 90 }, current });
  assert.notEqual(fresh?.action ?? null, 'eat', '饱食恢复出带后不再保留吃饭计划');
  // 目标场所消失时同样不保留
  const gone = pickIdleLifeAction({ needs: { ...FULL, satiety: 70 }, venues: [], position: POS,
    config: cfg, nowUtcMs: T0, actorId: 'npc:1', current });
  assert.equal(gone, null);
});

test('近分平局用确定性随机挑选：同快照同分钟恒定，跨对居民可不同', () => {
  const tie = { ...FULL, satiety: 64, fun: 61 }; // eat 与 read 分数接近
  const a1 = decide({ needs: tie, actorId: 'npc:1' });
  const a2 = decide({ needs: tie, actorId: 'npc:1' });
  assert.deepEqual({ action: a1.action, target: a1.target }, { action: a2.action, target: a2.target }, '同输入恒定');
  // 两个不同居民的决策允许不同（不强制全体趋同）
  const picks = new Set();
  for (let n = 1; n <= 6; n++) {
    const r = decide({ needs: tie, actorId: `npc:${n}` });
    picks.add(`${r.action}:${r.target}`);
  }
  assert.ok(picks.size >= 1);
});

test('场所能力只来自显式配置', () => {
  const list = listLifeVenues([
    { key: 'hotel', kind: 'place', businessKind: 'inn', x: 1, y: 1 },      // 客栈：不供餐
    { key: 'food', kind: 'place', businessKind: 'tavern', x: 2, y: 2 },   // 饭馆：eat
    { key: 'cafe', kind: 'place', businessKind: 'cafe', x: 3, y: 3 },     // 咖啡馆：eat
    { key: 'study', kind: 'place', businessKind: 'study', x: 4, y: 4 },   // 书斋：read+sit
    { key: 'home', kind: 'home', x: 5, y: 5 },                            // 住宅：eat+sit（自己家）
    { key: 'plaza', kind: 'outdoor', x: 6, y: 6 },                        // 露天：sit
    { key: ' unnamed-food', kind: 'place', businessKind: 'none', x: 7, y: 7 }, // 无配置：无供给
  ]);
  const byKey = new Map(list.map(v => [v.key, v]));
  assert.deepEqual(byKey.get('food').offers, ['eat']);
  assert.deepEqual(byKey.get('cafe').offers, ['eat']);
  assert.deepEqual(byKey.get('study').offers, ['read', 'sit']);
  assert.deepEqual(byKey.get('home').offers, ['eat', 'sit']);
  assert.deepEqual(byKey.get('plaza').offers, ['sit']);
  assert.equal(byKey.get('hotel'), undefined, '客栈不因名字/种类获得供食能力');
  assert.equal(byKey.get(' unnamed-food'), undefined, '未声明供给的地点不提供生活动作');
});

test('客满场所被排除：改选其他同类场所，滞回计划客满也让位', () => {
  // 唯一饭馆客满 → 不再产生吃饭候选（返回 null 交还游走/等待，不死循环）
  const noAlt = pickIdleLifeAction({ needs: { ...FULL, satiety: 30 }, venues: [
    { key: 'tavern_near', offers: ['eat'], x: 5, y: 5 }], position: POS,
    config: cfg, nowUtcMs: T0, actorId: 'npc:1', occupancy: { tavern_near: cfg.capacity.eat } });
  assert.equal(noAlt, null);
  // 有第二家饭馆 → 改选它
  const alt = pickIdleLifeAction({ needs: { ...FULL, satiety: 30 }, venues: [
    { key: 'tavern_near', offers: ['eat'], x: 5, y: 5 },
    { key: 'tavern_far', offers: ['eat'], x: 10, y: 10 }], position: POS,
    config: cfg, nowUtcMs: T0, actorId: 'npc:1', occupancy: { tavern_near: cfg.capacity.eat } });
  assert.equal(alt.action, 'eat');
  assert.equal(alt.target, 'tavern_far');
  // 滞回中的计划因客满被放弃
  const kept = pickIdleLifeAction({ needs: { ...FULL, satiety: 70 }, venues: [
    { key: 'tavern_near', offers: ['eat'], x: 5, y: 5 }], position: POS,
    config: cfg, nowUtcMs: T0, actorId: 'npc:1', occupancy: { tavern_near: cfg.capacity.eat },
    current: { action: 'eat', target: 'tavern_near' } });
  assert.equal(kept, null);
});

// ── 集成：真实主循环里的生活闭环（需求下降 → 选择场所 → 完成动作 → 需求恢复）──

test('M2 集成：饥饿居民自主前往饭馆进食并恢复饱食（零模型）', async t => {
  let now = Date.parse('2026-09-30T10:00:00+08:00');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clockRef = { now };
  t.mock.method(Date, 'now', () => clockRef.now);
  const db = getDb();
  const registry = createTownActorRegistry(db);
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });

  const sim = createTownHeadlessSim({ startUtcMs: now, name: 'life-loop',
    locations: [
      { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 4, y: 4, radius: 2 },
      { key: 'food', name: '老字号饭馆', kind: 'place', businessKind: 'tavern', x: 8, y: 8, radius: 1 },
      { key: 'study', name: '街尾书斋', kind: 'place', businessKind: 'study', x: 1, y: 8, radius: 1 },
    ],
    residents: [{ displayName: '闲散的阿快', job: '居民' }] });
  const actorId = registry.resolveAgentKey(`npc:${sim.npcIds[0]}`).actorId;
  const step = async (ms = 60_000) => { now += ms; sim.step(ms); clockRef.now = now; await new Promise(r => setImmediate(r)); };

  await step(); // 建立需求游标与档案
  // 压低饱食 → 吃饭应成为最高分候选
  const row = db.prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?').get(actorId);
  db.prepare('UPDATE town_resident_needs SET needs_json = ? WHERE actor_id = ?')
    .run(JSON.stringify({ ...JSON.parse(row.needs_json), satiety: 30 }), actorId);

  // 推进至吃完（移动 + 20 分钟进食；60s 步长保证资源租约续期）
  let eatDone = 0;
  for (let i = 0; i < 30; i++) {
    await step();
    eatDone = db.prepare(`SELECT count(*) n FROM town_actions
      WHERE actor_id = ? AND type = 'life_eat' AND status = 'completed'`).get(actorId).n;
    if (eatDone > 0) break;
  }
  assert.ok(eatDone > 0, '应完成 life_eat 动作（结算直接落在需求值上）');
  const after = JSON.parse(db.prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?')
    .get(actorId).needs_json);
  assert.ok(after.satiety > 60, `饱食应从 30 恢复到 60 以上，实际 ${after.satiety}`);
  // 同一动作只结算一次：完成态动作行不增加、饱食不再额外跳升
  const satietyBefore = JSON.parse(db.prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?').get(actorId).needs_json).satiety;
  for (let i = 0; i < 4; i++) await step();
  assert.equal(db.prepare(`SELECT count(*) n FROM town_actions
    WHERE actor_id = ? AND type = 'life_eat' AND status = 'completed'`).get(actorId).n, eatDone, '重复推进不产生新的结算来源');
  const satietyAfter = JSON.parse(db.prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?').get(actorId).needs_json).satiety;
  assert.ok(satietyAfter <= satietyBefore + 1, '没有重复的饱食恢复（只有自然衰减）');
});
