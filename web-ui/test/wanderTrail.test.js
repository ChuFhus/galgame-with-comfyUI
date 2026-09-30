import { test } from 'node:test';
import assert from 'node:assert/strict';
const { foldWanderTrail, mergeActivityWithTrail, WANDER_TRAIL_CAP } = await import('../src/town/wanderTrail.js');

const agent = (actorId, locationId, locationName, extra = {}) =>
  ({ actorId, agentKey: `npc:${actorId}`, kind: 'npc', locationId, locationName, path: [], ...extra });

test('足迹只记已到站的地点变化，同地点重复帧不重复记', () => {
  let trails = {};
  ({ trails } = foldWanderTrail(trails, [agent('a1', 5, '中央广场')], 1000));
  assert.equal(trails.a1.length, 1);
  assert.equal(trails.a1[0].text, '在中央广场闲逛');
  assert.equal(trails.a1[0].local, true);
  // 同一地点再来一帧：不新增
  const again = foldWanderTrail(trails, [agent('a1', 5, '中央广场')], 2000);
  assert.equal(again.changed, false);
  assert.equal(again.trails.a1.length, 1);
  // 换地点 → 记一条
  const moved = foldWanderTrail(trails, [agent('a1', 9, '街尾书斋')], 3000);
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.trails.a1.map(e => e.text), ['在中央广场闲逛', '在街尾书斋闲逛']);
});

test('走路中不记（路径非空），缺地点名不记，玩家不记', () => {
  const walking = { ...agent('a1', 9, '街尾书斋'), path: [{ x: 1, y: 1 }] };
  const r1 = foldWanderTrail({}, [walking], 1000);
  assert.equal(r1.changed, false, '赶路中的目标地点不算足迹');
  const nameless = foldWanderTrail({}, [agent('a1', 9, null)], 1000);
  assert.equal(nameless.changed, false);
  const player = foldWanderTrail({}, [{ agentKey: 'me', kind: 'player', actorId: 'me', locationId: 1, locationName: '广场', path: [] }], 1000);
  assert.equal(player.changed, false, '玩家自己不进足迹');
});

test('每位居民足迹有上限，超出丢最旧的', () => {
  let trails = {};
  for (let i = 0; i < WANDER_TRAIL_CAP + 8; i++) {
    trails = foldWanderTrail(trails, [agent('a1', i, `地点${i}`)], 1000 + i).trails;
  }
  assert.equal(trails.a1.length, WANDER_TRAIL_CAP);
  assert.equal(trails.a1[0].text, `在地点8闲逛`, '最旧的被丢弃');
  assert.equal(trails.a1[trails.a1.length - 1].text, `在地点${WANDER_TRAIL_CAP + 7}闲逛`);
});

test('合并列表按时间倒序，本地条目带 local 标记与稳定 id', () => {
  const entries = [
    { seq: 3, text: '在老字号饭馆上工', occurredAt: 5000 },
    { seq: 1, text: '动身去老字号饭馆', occurredAt: 1000 },
  ];
  const trail = [{ at: 3000, text: '在中央广场闲逛', locationKey: '5' }];
  const merged = mergeActivityWithTrail(entries, trail);
  assert.deepEqual(merged.map(e => e.text), ['在老字号饭馆上工', '在中央广场闲逛', '动身去老字号饭馆']);
  const local = merged.find(e => e.local);
  assert.ok(local.seq.startsWith('local:'), '本地条目 id 不参与后端 seq 空间');
  assert.deepEqual(mergeActivityWithTrail([], []), []);
  assert.equal(mergeActivityWithTrail(null, null).length, 0);
});
