import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`activity feed fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
const { createTownActivityFeed, describeAction, actionReason, ruleLabel } = await import('../src/services/town/townActivityFeed.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');
const { migrateTownActionSchema } = await import('../src/db/townActionSchema.js');

const db = getDb();
const registry = createTownActorRegistry(db);
const feed = createTownActivityFeed({ db, registry });
const world = registry.getWorldState();
const NOW = Date.parse('2026-09-30T10:00:00+08:00');

db.prepare(`INSERT INTO town_maps (name, grid_cols, grid_rows) VALUES ('feed', 8, 8)`).run();
const mapId = db.prepare('SELECT max(id) id FROM town_maps').get().id;
for (const [key, name] of [['food', '老字号饭馆'], ['study', '街尾书斋']]) {
  db.prepare(`INSERT INTO town_locations (map_id, key, name, grid_x, grid_y) VALUES (?, ?, ?, 1, 1)`).run(mapId, key, name);
}
db.prepare(`INSERT INTO town_npcs (map_id, display_name) VALUES (?, '掌柜老周')`).run(mapId);
const npcId = db.prepare('SELECT max(id) id FROM town_npcs').get().id;
registry.synchronize();
const actorId = db.prepare('SELECT actor_id FROM town_actors WHERE npc_id = ?').get(npcId).actor_id;

// 精简后的夹具：直接写动作行（一行动作 = 一条动态），不再有流水表
let seq = 0;
function action({ type, status, target = null, ruleKey = null, lastReason = null, failureReason = null, startedAt = NOW }) {
  const id = `act-${++seq}`;
  db.prepare(`INSERT INTO town_actions (id, world_id, world_epoch, actor_id, type, status, target, payload,
      rule_key, rule_version, started_at, due_at, updated_at, failure_reason, last_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?, ?, ?, ?)`)
    .run(id, world.worldId, world.epoch, actorId, type, status, target, ruleKey, startedAt, startedAt, startedAt,
      failureReason, lastReason);
  return id;
}

test('describeAction 一行动作一条动态：做成/失败/进行中，取消不展示', () => {
  assert.equal(describeAction({ type: 'move_to', status: 'completed' }, '老字号饭馆'), '到了老字号饭馆');
  assert.equal(describeAction({ type: 'move_to', status: 'failed', failure_reason: 'PATH_UNREACHABLE' }, '街尾书斋'), '想去街尾书斋，但路走不通');
  assert.equal(describeAction({ type: 'life_eat', status: 'completed' }, '老字号饭馆'), '在老字号饭馆吃了点东西');
  assert.equal(describeAction({ type: 'work_shift', status: 'running' }, '老字号饭馆'), '在老字号饭馆上工');
  assert.equal(describeAction({ type: 'life_read', status: 'running' }, null), '在镇上看书', '无地点时回退「在镇上」');
  assert.equal(describeAction({ type: 'life_eat', status: 'cancelled' }, '食品'), null, '取消态不展示');
  assert.equal(describeAction({ type: 'wait', status: 'completed' }, '广场'), null);
});

test('actionReason 给出「为什么」：失败原因优先，其次规则来源/上次流转理由', () => {
  assert.equal(actionReason({ status: 'failed', failure_reason: 'PATH_UNREACHABLE' }), '路走不通');
  assert.equal(actionReason({ status: 'running', rule_key: 'town.life.eat.urgent' }), '需求·饿得急');
  assert.equal(actionReason({ status: 'running', rule_key: 'town.routine.work' }), '作息·上班');
  assert.equal(actionReason({ status: 'running', rule_key: 'town.shelter.rain' }), '天气·避雨');
  assert.equal(actionReason({ status: 'cancelled', last_reason: 'SCHEDULE_CHANGED' }), '作息变了');
  assert.equal(ruleLabel(null), null);
});

test('feed 一行一动作：按时间倒序、带理由与状态，取消/等待完成不进流', () => {
  action({ type: 'work_shift', status: 'running', target: 'food', ruleKey: 'town.routine.work', startedAt: NOW });
  action({ type: 'move_to', status: 'failed', target: 'study', failureReason: 'PATH_UNREACHABLE', startedAt: NOW + 1000 });
  action({ type: 'life_eat', status: 'completed', target: 'food', ruleKey: 'town.life.eat', lastReason: 'DURATION_ELAPSED', startedAt: NOW + 2000 });
  action({ type: 'move_to', status: 'cancelled', target: 'study', lastReason: 'SCHEDULE_CHANGED', startedAt: NOW + 3000 });
  action({ type: 'wait', status: 'completed', target: 'food', startedAt: NOW + 4000 });

  const entries = feed.recent({ limit: 100 });
  assert.equal(entries.length, 3, '只保留值得展示的动作');
  assert.equal(entries[0].text, '在老字号饭馆吃了点东西', '最新在前');
  assert.equal(entries[0].reason, '需求·吃饭');
  assert.equal(entries[0].status, 'completed');
  assert.equal(entries[1].text, '想去街尾书斋，但路走不通');
  assert.equal(entries[1].reason, '路走不通');
  assert.equal(entries[2].text, '在老字号饭馆上工');
  assert.equal(entries[2].reason, '作息·上班');
  assert.ok(entries.every(e => e.name === '掌柜老周'));
});

test('同居民同文案 1 小时内连续重复折叠；ofActor 只回该居民', () => {
  const before = feed.ofActor(actorId, { limit: 100 }).length;
  action({ type: 'rest', status: 'completed', target: 'food', lastReason: 'DURATION_ELAPSED', startedAt: NOW + 10000 });
  action({ type: 'rest', status: 'completed', target: 'food', lastReason: 'DURATION_ELAPSED', startedAt: NOW + 11000 });
  const after = feed.ofActor(actorId, { limit: 100 });
  assert.equal(after.length, before + 1, '窗口内连续同文案只留一条');
  // 超过窗口的同文案重新出现
  action({ type: 'rest', status: 'completed', target: 'food', lastReason: 'DURATION_ELAPSED', startedAt: NOW + 10000 + 61 * 60_000 });
  assert.equal(feed.ofActor(actorId, { limit: 100 }).length, before + 2, '跨窗口的正常重复保留');
  assert.equal(after[0].text, '在老字号饭馆休息好了');
  assert.equal(feed.ofActor('nonexistent-actor', { limit: 100 }).length, 0);
  // limit 是「取最近 N 行动作」的上限，折叠发生在取行之后（最近两行正好是两条相同的休息 → 折成一条）
  assert.ok(feed.ofActor(actorId, { limit: 2 }).length <= 2, 'limit 作为行上限生效');
  assert.equal(after.length, 4, '该居民当前共 4 条不同动态');
  closeDb();
});
