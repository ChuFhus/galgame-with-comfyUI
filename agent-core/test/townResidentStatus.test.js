import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`status fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
const { createTownResidentStatus } = await import('../src/services/town/townResidentStatus.js');
const { createTownNeedsService } = await import('../src/services/town/townNeedsService.js');
const { createTownRelationshipService } = await import('../src/services/town/townRelationshipService.js');
const { createTownGoalService } = await import('../src/services/town/townGoalService.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');

const db = getDb();
const registry = createTownActorRegistry(db);
const world = registry.getWorldState();
const NOW = Date.parse('2026-09-30T10:00:00+08:00');

db.prepare(`INSERT INTO town_maps (name, grid_cols, grid_rows) VALUES ('status', 8, 8)`).run();
const mapId = db.prepare('SELECT max(id) id FROM town_maps').get().id;
db.prepare(`INSERT INTO town_npcs (map_id, display_name, job) VALUES (?, '掌柜老周', '饭馆掌柜')`).run(mapId);
db.prepare(`INSERT INTO town_npcs (map_id, display_name, job) VALUES (?, '书生小沈', '书斋先生')`).run(mapId);
registry.synchronize();
const actorId = db.prepare(`SELECT actor_id FROM town_actors WHERE npc_id = (SELECT id FROM town_npcs WHERE display_name='掌柜老周')`).get().actor_id;
const otherId = db.prepare(`SELECT actor_id FROM town_actors WHERE npc_id = (SELECT id FROM town_npcs WHERE display_name='书生小沈')`).get().actor_id;

test('居民状态聚合：需求/心情/目标/技能/最近来往都是已落库事实', () => {
  const status = createTownResidentStatus({ db, registry });
  // 需求：结算一次制造真实数据
  const needs = createTownNeedsService({ db, needsConfig: config.town.needs });
  needs.settleNeeds(world.worldId, actorId, NOW);
  needs.applyNeedEffects({ worldId: world.worldId, actorId, sourceKey: 'drain', effects: { satiety: -35, energy: -20 }, nowUtcMs: NOW });
  // 目标与技能
  const goals = createTownGoalService({ db, goalConfig: config.town.goals });
  goals.ensureGoals({ worldId: world.worldId, actorId, profile: { interests: ['阅读'] }, context: { hasWorkplace: true }, localDay: Math.floor(NOW / 86400000), nowUtcMs: NOW });
  goals.applyProgress({ worldId: world.worldId, actorId, sourceKey: 'work_shift:1', kind: 'work', amount: 1, nowUtcMs: NOW, localDay: Math.floor(NOW / 86400000) });
  // 关系
  const rels = createTownRelationshipService({ db, socialConfig: config.town.social });
  rels.applyMutualEffects({ worldId: world.worldId, actorIds: [actorId, otherId], sourceKey: 'encounter:1', effects: { familiarity: 12, affection: 3 }, nowUtcMs: NOW });

  const sheet = status.ofActor(actorId);
  assert.equal(sheet.name, '掌柜老周');
  assert.ok(sheet.needs.satiety.value < 100, '饱食应反映真实结算');
  assert.equal(sheet.needs.satiety.label, '饱食');
  assert.ok(sheet.mood && Number.isFinite(sheet.mood.value) && sheet.mood.label.length > 0);
  assert.ok(sheet.goals.length >= 1 && sheet.goals.every(g => g.title && g.status));
  assert.ok(sheet.skills.some(sk => sk.key === 'service' && sk.level > 0), '上工技能有进展');
  assert.ok(sheet.skills.every(sk => sk.label && Number.isFinite(sk.level)));
  assert.ok(sheet.relationships.some(r => r.name === '书生小沈' && r.familiarity > 0), '最近来往含熟悉的人');
});

test('未知居民返回空骨架而不是报错；无关系时不展示空条目', () => {
  const status = createTownResidentStatus({ db, registry });
  const ghost = status.ofActor('ghost-actor-id');
  assert.equal(ghost.needs, null);
  assert.equal(ghost.mood, null, '无需求档案不编造心情');
  assert.deepEqual(ghost.goals, []);
  assert.deepEqual(ghost.skills, []);
  assert.deepEqual(ghost.relationships, []);
  closeDb();
});
