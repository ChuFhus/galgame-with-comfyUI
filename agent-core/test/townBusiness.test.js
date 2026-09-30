import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`business fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
  timeZone: 'Asia/Shanghai' });
const { createTownBusinessService } = await import('../src/services/town/townBusinessService.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');

const T0 = Date.parse('2026-09-30T10:00:00+08:00');
const CFG = config.town.economy;
const WORLD = () => getDb().prepare('SELECT world_id, epoch FROM town_world_state WHERE singleton = 1').get();

/** 两位居民夹具：返回 actorId */
function fixtureActors(registry) {
  const db = getDb();
  const { mapId } = db.prepare(`INSERT INTO town_maps (name, grid_cols, grid_rows) VALUES ('biz', 8, 8) RETURNING id AS mapId`).get();
  const npcIds = [];
  for (const name of ['店员小张', '食客小王']) {
    const row = db.prepare(`INSERT INTO town_npcs (map_id, display_name) VALUES (?, ?) RETURNING id AS npcId`).get(mapId, name);
    npcIds.push(row.npcId);
  }
  registry.synchronize();
  const actorIds = npcIds.map(id =>
    db.prepare(`SELECT actor_id FROM town_actors WHERE npc_id = ? AND archived = 0`).get(id).actor_id);
  return { actorIds, mapId };
}

test('工资：work_shift 完成后由经营账户支付，只付一次，余额不足不增发', () => {
  const db = getDb();
  const registry = createTownActorRegistry(db);
  const { actorIds: [worker, other], mapId } = fixtureActors(registry);
  const biz = createTownBusinessService({ db, registry, businessConfig: CFG });
  const { world_id: worldId, epoch } = WORLD();

  assert.equal(biz.payWageFromVenue({ worldId, worldEpoch: epoch, mapId, venueKey: 'shop',
    actorId: worker, actionId: 'act-1', nowUtcMs: T0 }), 'paid');
  const venue = biz.ensureVenueAccount({ worldId, worldEpoch: epoch, mapId, venueKey: 'shop', nowUtcMs: T0 });
  assert.equal(venue.balance, CFG.venueSeed - CFG.wagePerShift, '场所扣工资');
  assert.equal(biz.ensureActorAccount({ worldId, worldEpoch: epoch, actorId: worker }).balance,
    CFG.actorSeed + CFG.wagePerShift, '居民得工资');
  // 同一动作只付一次
  assert.equal(biz.payWageFromVenue({ worldId, worldEpoch: epoch, mapId, venueKey: 'shop',
    actorId: worker, actionId: 'act-1', nowUtcMs: T0 + 1 }), 'paid');
  assert.equal(biz.ensureVenueAccount({ worldId, worldEpoch: epoch, mapId, venueKey: 'shop', nowUtcMs: T0 }).balance,
    CFG.venueSeed - CFG.wagePerShift, '重复结算不重复扣款');
  // 余额不足：不悄悄增发
  db.prepare('UPDATE economy_accounts SET balance = 1 WHERE account_id = ?').run(venue.accountId);
  assert.equal(biz.payWageFromVenue({ worldId, worldEpoch: epoch, mapId, venueKey: 'shop',
    actorId: other, actionId: 'act-2', nowUtcMs: T0 + 2 }), 'insufficient');
  assert.equal(biz.ensureActorAccount({ worldId, worldEpoch: epoch, actorId: other }).balance,
    CFG.actorSeed, '余额不足时其他居民不拿到工资');
});

test('消费：餐费进经营账户、库存核销；余额不足走免费公共餐食；不重复扣款', () => {
  const db = getDb();
  const registry = createTownActorRegistry(db);
  const { actorIds: [diner, broke], mapId } = fixtureActors(registry);
  const biz = createTownBusinessService({ db, registry, businessConfig: CFG });
  const { world_id: worldId, epoch } = WORLD();

  // 先补货建立库存，再消费
  assert.equal(biz.procureStock({ worldId, worldEpoch: epoch, mapId, venueKey: 'food', nowUtcMs: T0 }), 'bought');
  assert.equal(biz.chargeMeal({ worldId, worldEpoch: epoch, mapId, venueKey: 'food',
    actorId: diner, actionId: 'eat-1', nowUtcMs: T0 }), 'paid');
  const venue = biz.ensureVenueAccount({ worldId, worldEpoch: epoch, mapId, venueKey: 'food', nowUtcMs: T0 });
  assert.equal(venue.balance, CFG.venueSeed - CFG.procureCost + CFG.mealPrice, '餐费计入经营账户（已扣采购款）');
  assert.equal(biz.ensureActorAccount({ worldId, worldEpoch: epoch, actorId: diner }).balance,
    CFG.actorSeed - CFG.mealPrice);
  const stock = biz.ensureVenueStock({ worldId, worldEpoch: epoch, mapId, venueKey: 'food' });
  assert.equal(db.prepare('SELECT quantity FROM town_resource_stocks WHERE stock_id = ?').get(stock.stockId).quantity,
    CFG.procureBatch - 1, '一份餐食库存被核销');
  // 同一动作不重复扣款/核销
  biz.chargeMeal({ worldId, worldEpoch: epoch, mapId, venueKey: 'food', actorId: diner, actionId: 'eat-1', nowUtcMs: T0 + 1 });
  assert.equal(biz.ensureActorAccount({ worldId, worldEpoch: epoch, actorId: diner }).balance,
    CFG.actorSeed - CFG.mealPrice);
  // 余额不足 → 免费公共餐食（不发生账目）：先清空该居民余额
  const brokeAccount = biz.ensureActorAccount({ worldId, worldEpoch: epoch, actorId: broke });
  db.prepare('UPDATE economy_accounts SET balance = 0 WHERE account_id = ?').run(brokeAccount.accountId);
  assert.equal(biz.chargeMeal({ worldId, worldEpoch: epoch, mapId, venueKey: 'food',
    actorId: broke, actionId: 'eat-2', nowUtcMs: T0 + 2 }), 'public');
  assert.equal(biz.ensureActorAccount({ worldId, worldEpoch: epoch, actorId: broke }).balance, 0);
});

test('补货：低库存触发采购（钱去外部供应商、货转进来），按小时桶幂等', () => {
  const db = getDb();
  const registry = createTownActorRegistry(db);
  const { mapId } = fixtureActors(registry);
  const biz = createTownBusinessService({ db, registry, businessConfig: CFG });
  const { world_id: worldId, epoch } = WORLD();

  const first = biz.procureStock({ worldId, worldEpoch: epoch, mapId, venueKey: 'food', nowUtcMs: T0 });
  assert.equal(first, 'bought');
  const stock = biz.ensureVenueStock({ worldId, worldEpoch: epoch, mapId, venueKey: 'food' });
  assert.equal(db.prepare('SELECT quantity FROM town_resource_stocks WHERE stock_id = ?').get(stock.stockId).quantity,
    CFG.procureBatch, '补货 12 份入库');
  const venue = biz.ensureVenueAccount({ worldId, worldEpoch: epoch, mapId, venueKey: 'food', nowUtcMs: T0 });
  assert.equal(venue.balance, CFG.venueSeed - CFG.procureCost, '采购付款给外部供应商');
  // 同小时桶内不再重复采购（库存已高于阈值）
  assert.equal(biz.procureStock({ worldId, worldEpoch: epoch, mapId, venueKey: 'food', nowUtcMs: T0 + 60_000 }), 'enough');
  // 库存再次低于阈值但同一小时桶：来源键幂等，不重复付款也不重复到货
  db.prepare('UPDATE town_resource_stocks SET quantity = 0 WHERE stock_id = ?').run(stock.stockId);
  assert.equal(biz.procureStock({ worldId, worldEpoch: epoch, mapId, venueKey: 'food', nowUtcMs: T0 + 120_000 }), 'bought');
  assert.equal(db.prepare('SELECT quantity FROM town_resource_stocks WHERE stock_id = ?').get(stock.stockId).quantity, 0,
    '同一小时桶重复触发不重复到货');
});

test('账本守恒：全部金钱分录总和为零（复式记账约束）', () => {
  const db = getDb();
  const sum = db.prepare(`SELECT SUM(e.amount) total FROM economy_entries e
    JOIN economy_transactions t ON t.transaction_id = e.transaction_id
    WHERE t.world_id = (SELECT world_id FROM town_world_state WHERE singleton = 1)`).get().total;
  assert.equal(Number(sum), 0, '金钱分录总和必须为 0（发行方吸收所有流动）');
});

// ── 集成：真实主循环中的经营结算 ──

test('M4 集成：出勤发工资、进食付餐费进入真实账本', async t => {
  let now = Date.parse('2026-09-30T09:00:00+08:00');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clockRef = { now };
  t.mock.method(Date, 'now', () => clockRef.now);
  const db = getDb();
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });

  const sim = createTownHeadlessSim({ startUtcMs: now, name: 'biz-loop',
    locations: [
      { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 4, y: 4, radius: 2 },
      { key: 'food', name: '老字号饭馆', kind: 'place', businessKind: 'tavern', x: 8, y: 8, radius: 1 },
    ],
    residents: [{ displayName: '店员小张', job: '店员',
      routine: [{ start: '00:00', end: '24:00', locationKey: 'food', actionType: 'work_shift', activity: '看店' }] }] });
  const step = async (ms = 60_000) => { now += ms; sim.step(ms); clockRef.now = now; await new Promise(r => setImmediate(r)); };

  let wageSeen = false;
  for (let i = 0; i < 30 && !wageSeen; i++) {
    await step();
    wageSeen = !!db.prepare(`SELECT 1 FROM economy_transactions WHERE reason_code = 'SHIFT_WAGE'`).get();
  }
  assert.ok(wageSeen, 'work_shift 完成应发工资');
  const txCount = () => db.prepare(`SELECT count(*) n FROM economy_transactions WHERE reason_code = 'SHIFT_WAGE'`).get().n;
  const snapshot = txCount();
  await step();
  assert.ok(txCount() >= snapshot, '工资按出勤次数持续结算');
});
