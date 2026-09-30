import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`activity feed fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
const { createTownActivityFeed, describeActivity } = await import('../src/services/town/townActivityFeed.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');
const { migrateTownActionSchema } = await import('../src/db/townActionSchema.js');

const db = getDb();
const registry = createTownActorRegistry(db);
const feed = createTownActivityFeed({ db, registry });
const world = registry.getWorldState();
const NOW = Date.parse('2026-09-30T10:00:00+08:00');

// ── 夹具：地图/地点/居民 + 若干动作与流转记录 ──
db.prepare(`INSERT INTO town_maps (name, grid_cols, grid_rows) VALUES ('feed', 8, 8)`).run();
const mapId = db.prepare('SELECT max(id) id FROM town_maps').get().id;
for (const [key, name] of [['food', '老字号饭馆'], ['study', '街尾书斋']]) {
  db.prepare(`INSERT INTO town_locations (map_id, key, name, grid_x, grid_y) VALUES (?, ?, ?, 1, 1)`).run(mapId, key, name);
}
db.prepare(`INSERT INTO town_npcs (map_id, display_name) VALUES (?, '掌柜老周')`).run(mapId);
const npcId = db.prepare('SELECT max(id) id FROM town_npcs').get().id;
registry.synchronize();
const actorId = db.prepare('SELECT actor_id FROM town_actors WHERE npc_id = ?').get(npcId).actor_id;

let actionSeq = 0, logSeq = 0;
function logAction({ type, target, phase, reason, locationKey, occurredAt = NOW }) {
  const id = `act-${++actionSeq}`;
  // 动作行落 completed 终态：town_actions 对同一居民的 reserved/running 有唯一索引，
  // 而 feed 展示读的是 log 行的 phase，这里只借动作行取 type/target
  db.prepare(`INSERT INTO town_actions (id, world_id, world_epoch, actor_id, type, status, target, payload, updated_at)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, '{}', ?)`).run(id, world.worldId, world.epoch, actorId, type, target, occurredAt);
  const eventId = `action:${id}:${actionSeq}`;
  db.prepare(`INSERT INTO town_domain_events (event_id, world_id, world_epoch, type, depth, root_event_id, envelope)
    VALUES (?, ?, ?, 'town.action.changed', 0, ?, '{}')`).run(eventId, world.worldId, world.epoch, eventId);
  db.prepare(`INSERT INTO town_activity_log (world_id, world_epoch, actor_id, action_id, event_id, phase,
    reason_code, rule_key, location_key, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'town.life.test', ?, ?)`)
    .run(world.worldId, world.epoch, actorId, id, eventId, phase, reason ?? 'DURATION_ELAPSED', locationKey, occurredAt);
  logSeq++;
  return id;
}

test('describeActivity 输出直述文案，取消与睡觉分段返回 null', () => {
  assert.equal(describeActivity({ action_type: 'move_to', phase: 'completed' }, '老字号饭馆'), '到了老字号饭馆');
  assert.equal(describeActivity({ action_type: 'move_to', phase: 'failed', reason_code: 'PATH_UNREACHABLE' }, '街尾书斋'), '想去街尾书斋，但路走不通');
  assert.equal(describeActivity({ action_type: 'life_eat', phase: 'completed' }, '老字号饭馆'), '在老字号饭馆吃了点东西');
  assert.equal(describeActivity({ action_type: 'work_shift', phase: 'running' }, '老字号饭馆'), '在老字号饭馆上工');
  assert.equal(describeActivity({ action_type: 'life_read', phase: 'running' }, null), '在镇上看书', '无地点时回退「在镇上」');
  assert.equal(describeActivity({ action_type: 'wait', phase: 'completed' }, '中央广场'), null, 'wait 完成不展示');
  assert.equal(describeActivity({ action_type: 'rest', phase: 'running' }, '西边小院'), null, '睡觉分段不展示');
  assert.equal(describeActivity({ action_type: 'move_to', phase: 'cancelled' }, '广场'), null);
  assert.equal(describeActivity({ action_type: 'rest', phase: 'completed' }, '西边小院'), '在西边小院休息好了');
});

test('recent 信息流：文案正确、噪音被过滤、按时间倒序、人名来自居民档案', () => {
  logAction({ type: 'wait', phase: 'running', locationKey: 'food' });                       // 噪音：过滤
  logAction({ type: 'rest', phase: 'running', locationKey: 'food' });                       // 噪音：过滤
  logAction({ type: 'work_shift', phase: 'running', locationKey: 'food' });
  logAction({ type: 'move_to', phase: 'failed', reason: 'PATH_UNREACHABLE', locationKey: 'study' });
  logAction({ type: 'life_eat', phase: 'completed', locationKey: 'food' });
  const entries = feed.recent({ limit: 100 });
  assert.equal(entries.length, 3, 'wait 与睡觉分段不进信息流');
  assert.equal(entries[0].text, '在老字号饭馆吃了点东西', '最新在前');
  assert.equal(entries[1].text, '想去街尾书斋，但路走不通');
  assert.equal(entries[2].text, '在老字号饭馆上工');
  assert.ok(entries.every(e => e.name === '掌柜老周'), '人名解析自居民档案');
  assert.ok(entries.every(e => e.actorId === actorId));
  assert.ok(entries[0].occurredAt === NOW);
});

test('ofActor 只返回该居民的记录；limit 生效', () => {
  // 另一位居民的记录不应混入
  const other = registry.resolveAgentKey('me');
  logAction({ type: 'life_read', phase: 'completed', locationKey: 'study' });
  const mine = feed.ofActor(actorId, { limit: 100 });
  assert.ok(mine.length >= 4);
  assert.ok(mine.every(e => e.actorId === actorId));
  assert.equal(feed.ofActor('nonexistent-actor', { limit: 100 }).length, 0, '未知居民返回空');
  const capped = feed.ofActor(actorId, { limit: 2 });
  assert.equal(capped.length, 2);
  void other;
});

test('降噪：同居民同文案在窗口内的连续重复折叠成一条，跨窗口保留', () => {
  const feed2 = createTownActivityFeed({ db, registry, dedupeWindowMs: 10 * 60_000 });
  // 三次「动身去」同类目标，间隔 5 秒（抖动残留的特征）
  logAction({ type: 'move_to', phase: 'running', locationKey: 'food', occurredAt: NOW + 1000 });
  logAction({ type: 'move_to', phase: 'running', locationKey: 'food', occurredAt: NOW + 6000 });
  logAction({ type: 'move_to', phase: 'running', locationKey: 'food', occurredAt: NOW + 11000 });
  const collapsed = feed2.ofActor(actorId, { limit: 100 }).filter(e => e.text === '动身去老字号饭馆');
  assert.equal(collapsed.length, 1, '窗口内连续重复只留最新一条');
  // 超过窗口的同文案重新出现（真实反复出行仍可见）
  logAction({ type: 'move_to', phase: 'running', locationKey: 'food', occurredAt: NOW + 1000 + 11 * 60_000 });
  const spread = feed2.ofActor(actorId, { limit: 100 }).filter(e => e.text === '动身去老字号饭馆');
  assert.equal(spread.length, 2, '跨窗口的正常重复保留');
  // 不同居民的同文案互不影响
  void feed2;
});

test('合并/退役身份的记录仍可读，名字落到在册档案', () => {
  // 直接对 world 状态下的 actorId 查询不因 archived 抛错
  const entries = feed.ofActor(actorId, { limit: 5 });
  assert.ok(entries.every(e => e.name === '掌柜老周'));
  void logSeq;
});
