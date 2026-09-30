import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`stroll fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 2,
  timeZone: 'Asia/Shanghai', maxActiveEncounters: 0, encounterStrangerProb: 1, encounterRelatedProb: 1,
  encounterMinStartGapMin: 0 });
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');
const { purgeTownActionHistory } = await import('../src/services/town/townService.js');

const T0 = Date.parse('2026-09-30T09:00:00+08:00');
const db = getDb();

test('自然走动是纯演出：游走不落 town_actions 行，走位照常；生活动作照常落行结算', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  // tickSeconds=300 → 动作租约 15 分钟（同 sevenDay 口径）；阶段 2 用 10 分钟步长保证租约安全
  config.town.tickSeconds = 300;
  const sim = createTownHeadlessSim({ startUtcMs: now, name: 'stroll-town',
    locations: [
      { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 6, y: 6, radius: 3 },
      { key: 'pavilion', name: '东凉亭', kind: 'outdoor', x: 10, y: 2, radius: 2 },
      { key: 'food', name: '老字号饭馆', kind: 'place', businessKind: 'tavern', x: 2, y: 2, radius: 1 },
      { key: 'home_a', name: '西边小院', kind: 'home', x: 1, y: 11, radius: 1 },
      { key: 'home_b', name: '南边小院', kind: 'home', x: 11, y: 11, radius: 1 },
    ],
    residents: [
      { displayName: '闲散的阿圆', job: '居民' },
      { displayName: '爱走的阿快', job: '居民' },
      { displayName: '守亭的老柏', job: '居民',
        routine: [{ start: '07:00', end: '21:00', locationKey: 'pavilion', activity: '守亭' }] },
    ] });
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });

  const step = async (ms = 60_000) => { now += ms; sim.step(ms); await new Promise(r => setImmediate(r)); };
  const byName = name => sim.state().agents.find(a => a.displayName === name);

  // ── 阶段 1：纯空闲 20 分钟（跨多个 30s 游走桶）——旧实现这里每人每分钟都要
  // 取消重建一两行 move_to/wait；游走出 FSM 后不该有任何动作行 ──
  const spawn = new Map(sim.state().agents.map(a => [a.displayName, { x: a.x, y: a.y }]));
  for (let i = 0; i < 20; i++) await step();
  const strollers = ['闲散的阿圆', '爱走的阿快'].map(byName);
  const strollIds = strollers.map(a => a.actorId);
  assert.ok(strollIds.every(id => typeof id === 'string' && id), '游走居民应有 actorId');
  assert.equal(db.prepare('SELECT count(*) n FROM town_actions').get().n, 0,
    '空闲游走阶段全镇不应产生任何 town_actions 行（自然走动是纯演出）');
  const walked = strollers.some(a => a && (Math.abs(a.x - spawn.get(a.displayName).x)
    + Math.abs(a.y - spawn.get(a.displayName).y)) > 0);
  assert.ok(walked, '自然走动应真实发生：位置应离开出生点');

  // ── 阶段 2：需求衰减触发生活决策 —— 有意义的目标移动仍由 FSM 记录并结算 ──
  // satiety 衰减约 1.75-2/h：降到 eatBelow(65) 以下并稳定触发需要 ~24 小时
  while (now < T0 + 24 * 3600_000) await step(10 * 60_000);
  for (let i = 0; i < 5; i++) await step(10 * 60_000); // 让在飞的 life_eat 跑完进入结算
  const lifeRows = db.prepare("SELECT count(*) n FROM town_actions WHERE type LIKE 'life_%'").get().n;
  assert.ok(lifeRows > 0, '需求衰减后应产生生活动作行（有意义移动仍记录）');
  // 精简后：结算不再另开台账表，「吃到饭」看动作行本身（完成态 life_eat）
  const eatSettled = db.prepare("SELECT count(*) n FROM town_actions WHERE type = 'life_eat' AND status = 'completed'").get().n;
  assert.ok(eatSettled > 0, '生活动作的需求结算照常（来源键幂等）');
  const cancelled = db.prepare("SELECT count(*) n FROM town_actions WHERE status = 'cancelled'").get().n;
  assert.equal(cancelled, 0, '无打断时不应出现取消重建（决策节奏与动作自然时长对齐）');
});

test('purgeTownActionHistory 只清 7 天前终态行：活跃行与近期行不动', async () => {
  const fresh = getDb();
  const ins = fresh.prepare(`INSERT INTO town_actions(id,world_id,world_epoch,actor_id,type,status,version,
    target,payload,rule_key,rule_version,updated_at) VALUES (?,?,?,?,?,?,1,NULL,'{}',NULL,NULL,?)`);
  const now = Date.now();
  ins.run('purge-old-cancelled', 'w', 1, 'a', 'move_to', 'cancelled', now - 8 * 86400_000);
  ins.run('purge-old-completed', 'w', 1, 'a', 'wait', 'completed', now - 8 * 86400_000);
  ins.run('purge-old-running', 'w', 1, 'a', 'move_to', 'running', now - 8 * 86400_000);
  ins.run('purge-new-cancelled', 'w', 1, 'a', 'move_to', 'cancelled', now - 1 * 86400_000);
  const res = await purgeTownActionHistory({ nowMs: now });
  assert.ok(res.deleted >= 2, `应至少清掉两行 7 天前终态行，实际 ${res.deleted}`);
  assert.equal(fresh.prepare(
    "SELECT count(*) n FROM town_actions WHERE id IN ('purge-old-running','purge-new-cancelled')").get().n, 2,
    '活跃行与 7 天内终态行必须保留');
  assert.equal(fresh.prepare(
    "SELECT count(*) n FROM town_actions WHERE id IN ('purge-old-cancelled','purge-old-completed')").get().n, 0,
    '7 天前终态行应被清掉');
  closeDb();
});
