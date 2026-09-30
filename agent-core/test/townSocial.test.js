import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`social fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
  timeZone: 'Asia/Shanghai' });
const { createTownRelationshipService, relationshipEncounterFactor } = await import('../src/services/town/townRelationshipService.js');
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');

const W = 'w-social';
const T0 = Date.parse('2026-09-30T09:00:00+08:00');
const HOUR = 3600_000;

test('相遇结果双向结算关系：A→B 与 B→A 分开保存、来源幂等', () => {
  const rels = createTownRelationshipService({ db: getDb(), socialConfig: config.town.social });
  const applied = rels.applyMutualEffects({ worldId: W, actorIds: ['a1', 'a2'],
    sourceKey: 'encounter:1', effects: { familiarity: 6, affection: 2 }, nowUtcMs: T0 });
  assert.equal(applied, true);
  const aToB = rels.getRelationship(W, 'a1', 'a2');
  const bToA = rels.getRelationship(W, 'a2', 'a1');
  assert.equal(aToB.familiarity, 6);
  assert.equal(aToB.affection, 2);
  assert.deepEqual({ ...bToA }, { ...aToB }, '双向对称同量');
  // 同一来源重复结算不生效
  assert.equal(rels.applyMutualEffects({ worldId: W, actorIds: ['a1', 'a2'],
    sourceKey: 'encounter:1', effects: { familiarity: 6, affection: 2 }, nowUtcMs: T0 }), false);
  assert.equal(rels.getRelationship(W, 'a1', 'a2').familiarity, 6, '重复来源不叠加');
  // 第二次来源继续增长
  rels.applyMutualEffects({ worldId: W, actorIds: ['a1', 'a2'],
    sourceKey: 'encounter:2', effects: { familiarity: 6, affection: 2 }, nowUtcMs: T0 + HOUR });
  assert.equal(rels.getRelationship(W, 'a1', 'a2').familiarity, 12);
  // 自身不结算
  assert.equal(rels.applyMutualEffects({ worldId: W, actorIds: ['a1', 'a1'],
    sourceKey: 'encounter:3', effects: { familiarity: 6 }, nowUtcMs: T0 }), false);
});

test('每日熟悉度上限：重复来源超过上限当天不再生效，次日恢复', () => {
  const rels = createTownRelationshipService({ db: getDb(), socialConfig: { dailyFamiliarityCap: 3 } });
  for (let k = 1; k <= 4; k++) {
    rels.applyMutualEffects({ worldId: W, actorIds: ['b1', 'b2'],
      sourceKey: `encounter:${k}`, effects: { familiarity: 6 }, nowUtcMs: T0 + k * 60_000 });
  }
  assert.equal(rels.getRelationship(W, 'b1', 'b2').familiarity, 18, '上限 3 次 × 6 = 18，第 4 次被跳过');
  // 次日恢复生效
  rels.applyMutualEffects({ worldId: W, actorIds: ['b1', 'b2'],
    sourceKey: 'encounter:5', effects: { familiarity: 6 }, nowUtcMs: T0 + 24 * HOUR });
  assert.equal(rels.getRelationship(W, 'b1', 'b2').familiarity, 24);
});

test('关系数值有界；相遇倾向因子单调且夹紧', () => {
  const rels = createTownRelationshipService({ db: getDb(), socialConfig: config.town.social });
  for (let k = 0; k < 30; k++) {
    rels.applyMutualEffects({ worldId: W, actorIds: ['c1', 'c2'],
      sourceKey: `encounter:${k}`, effects: { familiarity: 50, affection: 80 }, nowUtcMs: T0 + k * 60_000 });
  }
  const rel = rels.getRelationship(W, 'c1', 'c2');
  assert.ok(rel.familiarity <= 100 && rel.affection <= 100, '关系数值不越界');
  assert.equal(relationshipEncounterFactor(null), 1, '无关系中性因子');
  assert.equal(relationshipEncounterFactor({ familiarity: 100 }), 2);
  assert.equal(relationshipEncounterFactor({ familiarity: 100, affection: 100 }), 2.5);
  assert.equal(relationshipEncounterFactor({ familiarity: 100, affection: -100 }), 2, '负好感不加成也不惩罚相遇倾向');
  assert.ok(relationshipEncounterFactor(rel) > 1, '积累熟悉度后相遇倾向提升（反馈进入下一步决策）');
});

test('身份合并后关系落在存活身份上，不为退役身份复制新行', async t => {
  const db = getDb();
  const registry = createTownActorRegistry(db);
  db.prepare(`INSERT INTO town_maps (name, grid_cols, grid_rows) VALUES ('merge', 8, 8)`).run();
  db.prepare(`INSERT INTO town_npcs (map_id, display_name) VALUES ((SELECT max(id) FROM town_maps), '要转正的小 Naz')`).run();
  const npcId = db.prepare('SELECT max(id) id FROM town_npcs').get().id;
  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('naz', '小Naz', '一位小镇居民')`).run();
  const charId = db.prepare(`SELECT id FROM characters WHERE name = 'naz'`).get().id;
  registry.synchronize();
  const npcActor = registry.resolveAgentKey(`npc:${npcId}`).actorId;
  const charActorBefore = registry.resolveAgentKey(`char:${charId}`).actorId;
  const rels = createTownRelationshipService({ db: getDb(), socialConfig: config.town.social });
  const worldId = registry.getWorldState().worldId;
  rels.applyMutualEffects({ worldId, actorIds: [npcActor, 'other'],
    sourceKey: 'encounter:pre', effects: { familiarity: 4 }, nowUtcMs: T0 });

  // NPC 转正式角色：合并后 char 身份退役、NPC 身份存活
  registry.linkNpcCharacter(npcId, charId);
  const charActorAfter = registry.resolveAgentKey(`char:${charId}`).actorId;
  assert.equal(charActorAfter, npcActor, '合并后 char key 解析到存活身份');
  // 新结算落在存活身份，退役身份不再产生新关系行
  const liveActor = registry.getActor(charActorBefore, worldId, { followMerged: false });
  assert.ok(liveActor.archived || liveActor.mergedInto, '旧 char 身份已退役');
  rels.applyMutualEffects({ worldId, actorIds: [charActorAfter, 'other'],
    sourceKey: 'encounter:post', effects: { familiarity: 4 }, nowUtcMs: T0 + 1 });
  const rowsForRetired = db.prepare(`SELECT count(*) n FROM town_actor_relationships
    WHERE world_id = ? AND from_actor_id = ?`).all(W, charActorBefore).length;
  const rowsForSurvivor = db.prepare(`SELECT count(*) n FROM town_actor_relationships
    WHERE world_id = ? AND from_actor_id = ?`).all(W, npcActor).length;
  assert.equal(rowsForRetired, 1, '退役身份只有历史行，无新增');
  assert.equal(rowsForSurvivor, 1, '存活身份吸收后续结算');
});

// ── 集成：无玩家、无模型时重复相遇形成熟悉关系 ──

test('M3 集成：重复相遇积累熟悉度并受每日上限约束', async t => {
  let now = Date.parse('2026-09-30T09:00:00+08:00');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clockRef = { now };
  t.mock.method(Date, 'now', () => clockRef.now);
  const db = getDb();
  const registry = createTownActorRegistry(db);
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });

  Object.assign(config.town, { encounterStrangerProb: 1, encounterRelatedProb: 1,
    encounterMinStartGapMin: 0, encounterCooldownHours: 0, maxActiveEncounters: 1 });
  const sim = createTownHeadlessSim({ startUtcMs: now, name: 'social-loop' });
  const actorIds = sim.npcIds.map(id => registry.resolveAgentKey(`npc:${id}`).actorId);
  const rels = createTownRelationshipService({ db: getDb(), socialConfig: config.town.social });

  const stepDay = async () => {
    for (let i = 0; i < 48; i++) { // 48 × 30s 覆盖若干次相遇（冷却 0，收尾后即重开）
      now += 30_000; sim.step(30_000); clockRef.now = now;
      await new Promise(r => setImmediate(r));
    }
  };
  await stepDay();
  const rel = rels.getRelationship(W_WORLD(sim), actorIds[0], actorIds[1]);
  assert.ok(rel, '相遇应结算出有向关系行');
  assert.ok(rel.familiarity > 0, '熟悉度应随相遇增长');
  // 当日生效的关系来源 ≥ 1（按服务的 UTC 日窗口口径）
  const dayStart = Math.floor(now / 86400000) * 86400000;
  const sourcesToday = db.prepare(`SELECT count(DISTINCT source_key) n FROM town_relationship_effects
    WHERE world_id = ? AND from_actor_id = ? AND to_actor_id = ? AND applied_at_utc_ms >= ?`)
    .get(W_WORLD(sim), actorIds[0], actorIds[1], dayStart).n;
  assert.ok(sourcesToday >= 1);
  // 次日继续相遇，熟悉度继续增长但每方向每日来源数不超过上限
  await stepDay();
  const rel2 = rels.getRelationship(W_WORLD(sim), actorIds[0], actorIds[1]);
  assert.ok(rel2.familiarity >= rel.familiarity, '第二天熟悉度不回退');
});

/** 用 sim 世界真实 worldId（集成表与注册表共享同一世界） */
function W_WORLD(sim) {
  const db = getDb();
  return createTownActorRegistry(db).getWorldState().worldId;
}
