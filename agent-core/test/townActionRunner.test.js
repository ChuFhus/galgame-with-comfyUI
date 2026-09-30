import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateTownActionSchema } from '../src/db/townActionSchema.js';
import { createTownActionRunner } from '../src/services/town/townActionRunner.js';

const WORLD = 'world-1', EPOCH = 1, ACTOR = 'npc:1';
const actor = { actorId: ACTOR, participating: true, archived: false, mergedInto: null };

function buildRunner(db, nowRef) {
  // leaseMs 拉长到 1 小时：单元测试的一步时间跳跃不会像真实 tick 那样沿途续租。
  return createTownActionRunner({ db, clock: { now: () => nowRef.now }, leaseMs: 3600000,
    getWorldEpoch: () => EPOCH, getActor: id => (id === ACTOR ? actor : null),
    readFacts: () => ({ worldEpoch: EPOCH, actorId: ACTOR, targetExists: true,
      arrived: true, locationKey: 'cloud-cafe', allowsAction: true }) });
}

// 精简后：理由落在动作行自身（不再另开流水表/动作事件）
const reasons = db => db.prepare("SELECT status, last_reason AS reason FROM town_actions WHERE status != 'validated' ORDER BY version").all();
const rowCount = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

test('动作生命周期只留一行事实（状态+理由），不再写流水/事件/幂等台账', () => {
  const db = new Database(':memory:');
  migrateTownActionSchema(db);
  const nowRef = { now: 1760000000000 };
  const runner = buildRunner(db, nowRef);

  const scope = { worldId: WORLD, worldEpoch: EPOCH, actorId: ACTOR };
  const created = runner.create({ ...scope, type: 'work_shift', target: 'cloud-cafe',
    payload: { durationMs: 300000 } });
  const reserved = runner.reserve({ ...scope, actionId: created.id, expectedVersion: created.version });
  const started = runner.start({ ...scope, actionId: reserved.id, expectedVersion: reserved.version });
  assert.equal(started.phase, 'running');
  // 每次进程重启后的首个 tick 会对进行中动作补 recover；状态未变时不得产生新记录。
  const recovered = runner.recover({ ...scope, actionId: started.id, expectedVersion: started.version });
  assert.equal(recovered.phase, 'running');
  runner.advance({ ...scope, actionId: recovered.id, expectedVersion: recovered.version });
  nowRef.now += 300001;
  const completed = runner.advance({ ...scope, actionId: recovered.id, expectedVersion: recovered.version });
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.result.attendanceMs, 300000);

  // 一行动作承载最终状态与理由
  assert.deepEqual(reasons(db), [{ status: 'completed', reason: 'DURATION_ELAPSED' }]);
  // 未传 idempotencyKey（模拟内部命令）时不落幂等台账
  assert.equal(rowCount(db, 'town_action_requests'), 0, '模拟命令不写幂等台账');
  // 不再写动作领域事件（信息流直接读动作行）；活动流水表已整体删除
  assert.equal(db.prepare(`SELECT count(*) n FROM sqlite_master
    WHERE type='table' AND name='town_activity_log'`).get().n, 0, 'town_activity_log 应已删除');
  assert.equal(rowCount(db, 'town_domain_events'), 0);
});

test('显式传 idempotencyKey 的调用方仍获得重放保护', () => {
  const db = new Database(':memory:');
  migrateTownActionSchema(db);
  const nowRef = { now: 1760000000000 };
  const runner = buildRunner(db, nowRef);
  const scope = { worldId: WORLD, worldEpoch: EPOCH, actorId: ACTOR };
  const created = runner.create({ ...scope, type: 'rest', payload: { durationMs: 300000 }, idempotencyKey: 'create:1' });
  const again = runner.create({ ...scope, type: 'rest', payload: { durationMs: 300000 }, idempotencyKey: 'create:1' });
  assert.equal(again.id, created.id, '同键重放返回原结果');
  assert.equal(rowCount(db, 'town_action_requests'), 1, '显式键才落台账');
  assert.throws(() => runner.create({ ...scope, type: 'work_shift', target: 'cloud-cafe',
    payload: { durationMs: 300000 }, idempotencyKey: 'create:1' }), /IDEMPOTENCY_CONFLICT/);
});

test('recover that loses its lease still records the failure', () => {
  const db = new Database(':memory:');
  migrateTownActionSchema(db);
  const nowRef = { now: 1760000000000 };
  const runner = buildRunner(db, nowRef);
  const scope = { worldId: WORLD, worldEpoch: EPOCH, actorId: ACTOR };
  const created = runner.create({ ...scope, type: 'rest', payload: { durationMs: 300000 }, idempotencyKey: 'create:1' });
  const reserved = runner.reserve({ ...scope, actionId: created.id, expectedVersion: created.version, idempotencyKey: 'reserve:1' });
  const started = runner.start({ ...scope, actionId: reserved.id, expectedVersion: reserved.version, idempotencyKey: 'start:1' });
  // 租约（1 小时）到期后 recover 必须以 LEASE_EXPIRED 落记录，而不是被静音吞掉。
  nowRef.now += 3600001;
  const failed = runner.recover({ ...scope, actionId: started.id, expectedVersion: started.version, idempotencyKey: 'recover:expired' });
  assert.equal(failed.phase, 'failed');
  assert.deepEqual(reasons(db), [{ status: 'failed', reason: 'LEASE_EXPIRED' }]);
});

test('取消动作保留具体原因（留在动作行 last_reason 里可查）', () => {
  const db = new Database(':memory:');
  migrateTownActionSchema(db);
  const nowRef = { now: 1760000000000 };
  const runner = buildRunner(db, nowRef);
  const scope = { worldId: WORLD, worldEpoch: EPOCH, actorId: ACTOR };
  const created = runner.create({ ...scope, type: 'rest', payload: { durationMs: 300000 }, idempotencyKey: 'create:1' });
  runner.cancel({ ...scope, actionId: created.id, expectedVersion: created.version,
    reasonCode: 'SCHEDULE_CHANGED', idempotencyKey: 'cancel:1' });
  assert.deepEqual(reasons(db), [{ status: 'cancelled', reason: 'SCHEDULE_CHANGED' }]);
});
