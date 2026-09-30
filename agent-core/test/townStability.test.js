import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`stability fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
  timeZone: 'Asia/Shanghai', maxActiveEncounters: 1, encounterStrangerProb: 1, encounterRelatedProb: 1,
  encounterMinStartGapMin: 0 });
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');

const T0 = Date.parse('2026-09-30T09:00:00+08:00');
const db = getDb();
const needsOf = actorId =>
  JSON.parse(db.prepare('SELECT needs_json FROM town_resident_needs WHERE actor_id = ?').get(actorId)?.needs_json ?? '{}');

/** 全体居民需求都有界且有限 */
function assertNeedsBounded(sim) {
  const actors = db.prepare('SELECT actor_id, needs_json FROM town_resident_needs').all();
  assert.ok(actors.length >= sim.npcIds.length);
  for (const row of actors) {
    for (const [key, value] of Object.entries(JSON.parse(row.needs_json))) {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 100, `${key} 应有界，实际 ${value}`);
    }
  }
}

// 同一进程共享内存库：稳定性场景放在一个测试里按阶段执行
test('T07 稳定性：缺钱缺货 + 离线恢复（零模型）', async t => {
  let now = T0;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clockRef = { now };
  t.mock.method(Date, 'now', () => clockRef.now);
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });

  const sim = createTownHeadlessSim({ startUtcMs: now, name: 'stability-broke',
    locations: [
      { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 4, y: 4, radius: 2 },
      { key: 'food', name: '老字号饭馆', kind: 'place', businessKind: 'tavern', x: 8, y: 8, radius: 1 },
    ],
    residents: [{ displayName: '穷苦的阿慢', job: '居民' }] });
  const actorId = db.prepare('SELECT actor_id FROM town_actors WHERE npc_id IS NOT NULL').get()?.actor_id;
  const step = async (ms = 60_000) => { now += ms; sim.step(ms); clockRef.now = now; await new Promise(r => setImmediate(r)); };
  await step();
  // 清空居民与饭馆的全部资金：缺钱 + 缺货（无采购款）叠加
  db.prepare(`UPDATE economy_accounts SET balance = 0`).run();
  // 推进一整天：吃饭应走免费公共餐食，饱食不锁死在 0
  for (let i = 0; i < 240; i++) await step();
  assertNeedsBounded(sim);
  const needs = needsOf(actorId);
  assert.ok(needs.satiety > 20, `缺钱缺货下饱食仍应有恢复渠道，实际 ${needs.satiety}`);
  // 没有悄悄增发：全部账户余额仍为 0（公共餐食不发生账目）
  const total = db.prepare('SELECT COALESCE(SUM(balance),0) total FROM economy_accounts').get().total;
  assert.equal(total, 0, '公共餐食不产生账目，账户不凭空有钱');
  sim.stop();

  // ── 阶段二：离线恢复（同一世界，重启 + 三天离线）──
  sim.stop();
  const satietyBefore = needsOf(actorId).satiety;

  // 离线三天（虚拟时钟直接跳过，不驱动任何 tick）
  now += 3 * 24 * 3600_000;
  clockRef.now = now;
  sim.start(); // loadState → 保守恢复
  // 恢复运行：第一拍只承认 12 小时的需求衰减（温和截断）
  await step();
  const satietyAfter = needsOf(actorId).satiety;
  assert.ok(satietyBefore - satietyAfter <= 2 * 12 + 1, `离线衰减应被截断在 12 小时口径，实际下降 ${satietyBefore - satietyAfter}`);
  // 世界继续正常运转：再次相遇照常结算且不重复
  for (let i = 0; i < 6; i++) await step();
  const encounters = db.prepare('SELECT id, status FROM town_encounters').all();
  for (const enc of encounters) {
    assert.equal(enc.status, 'done', '离线恢复后不应有卡死的相遇');
    const eventCount = db.prepare('SELECT count(*) n FROM town_domain_events WHERE event_id = ?')
      .get(`encounter:${enc.id}`).n;
    assert.equal(eventCount, 1, '同一相遇只入账一次');
  }
  assertNeedsBounded(sim);
});
