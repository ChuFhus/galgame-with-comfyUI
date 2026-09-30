import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`director fixture forbids network: ${url}`); };
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
const { createTownDirectorService } = await import('../src/services/town/townDirectorService.js');
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');

const T0 = Date.parse('2026-09-30T09:00:00+08:00');
const W = 'w-director';

test('导演节奏：repeat_key 幂等、邀请间隔与每日上限、到期关闭', () => {
  const director = createTownDirectorService({ db: getDb(),
    directorConfig: { candidateTtlMs: 5000, inviteDailyCap: 1, inviteGapMs: 1000 } });
  // repeat_key 幂等：同键重复建立只生效一次
  assert.equal(director.propose({ worldId: W, repeatKey: 'stockout:1:food:100', kind: 'stockout',
    mapId: 1, payload: { venueKey: 'food' }, nowUtcMs: T0 }), true);
  assert.equal(director.propose({ worldId: W, repeatKey: 'stockout:1:food:100', kind: 'stockout',
    mapId: 1, payload: { venueKey: 'food' }, nowUtcMs: T0 + 1 }), false);
  // 间隔未到：新候选不邀请
  assert.equal(director.nextInvite({ worldId: W, nowUtcMs: T0 + 500 }), null, '恢复期内不邀请');
  // 间隔到了：按重要性挑选
  director.propose({ worldId: W, repeatKey: 'goal-done:a:career:100', kind: 'goal_done',
    mapId: 1, payload: {}, nowUtcMs: T0 });
  const picked = director.nextInvite({ worldId: W, nowUtcMs: T0 + 1100 });
  assert.ok(picked, '间隔后应挑出候选');
  assert.equal(picked.kind, 'goal_done', '重要性高的先被邀请');
  director.markInvited({ worldId: W, repeatKey: picked.repeat_key, nowUtcMs: T0 + 1100 });
  // 每日上限：已邀请 1 条，不再邀请
  assert.equal(director.nextInvite({ worldId: W, nowUtcMs: T0 + 2000 }), null);
  // 到期关闭
  director.expireDue({ worldId: W, nowUtcMs: T0 + 6000 });
  assert.equal(director.get({ worldId: W, repeatKey: 'stockout:1:food:100' }).status, 'expired', '过期即关闭');
  // 自行处理
  director.propose({ worldId: W, repeatKey: 'stockout:1:food2:100', kind: 'stockout',
    mapId: 1, payload: {}, nowUtcMs: T0 });
  director.resolve({ worldId: W, repeatKey: 'stockout:1:food2:100', nowUtcMs: T0 + 6100 });
  assert.equal(director.get({ worldId: W, repeatKey: 'stockout:1:food2:100' }).status, 'handled');
});

// ── 集成：真实条件触发导演候选；零模型下不生成邀请、候选自然关闭 ──

test('M6 集成：库存见底触发候选、条件恢复自行处理、零模型无邀请', async t => {
  let now = T0;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clockRef = { now };
  t.mock.method(Date, 'now', () => clockRef.now);
  const db = getDb();
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });

  const sim = createTownHeadlessSim({ startUtcMs: now, name: 'director-loop',
    locations: [
      { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 4, y: 4, radius: 2 },
      { key: 'food', name: '老字号饭馆', kind: 'place', businessKind: 'tavern', x: 8, y: 8, radius: 1 },
    ],
    residents: [{ displayName: '看店的阿圆', job: '居民' }] });
  const step = async (ms = 60_000) => { now += ms; sim.step(ms); clockRef.now = now; await new Promise(r => setImmediate(r)); };

  await step(); // 建立账户/库存（补货把库存买满）
  const candidateCount = () => db.prepare('SELECT count(*) n FROM town_director_candidates').get().n;
  const openByKey = key => db.prepare(`SELECT status FROM town_director_candidates WHERE repeat_key = ?`).get(key);

  // 制造缺货且无力补货：清空库存与经营账户
  db.prepare(`UPDATE town_resource_stocks SET quantity = 0 WHERE owner_key LIKE 'venue:%'`).run();
  db.prepare(`UPDATE economy_accounts SET balance = 0 WHERE account_type = 'business'`).run();
  const day = Math.floor(now / 86400000);
  for (let i = 0; i < 5; i++) await step();
  const stockKey = `stockout:${sim.mapId}:food:${day}`;
  assert.ok(openByKey(stockKey), '库存见底应触发导演候选');
  assert.equal(openByKey(stockKey).status, 'open');
  // 零模型（townLLM 关）不生成邀请演出，候选保持 open
  assert.equal(db.prepare(`SELECT count(*) n FROM town_npc_events WHERE event_type_key LIKE 'town.ambient%'`).get().n, 0);

  // 条件恢复 → 候选自行处理（补货到货后检测层看到库存恢复；直接置库存模拟到货）
  db.prepare(`UPDATE town_resource_stocks SET quantity = 12 WHERE owner_key LIKE 'venue:%'`).run();
  for (let i = 0; i < 4; i++) await step();
  assert.equal(openByKey(stockKey).status, 'handled', '库存恢复后候选应自行处理');
  assert.ok(candidateCount() >= 1);
});
