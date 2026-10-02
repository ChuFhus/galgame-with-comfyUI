import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryTownResident, isTownCarried, CARRY_LEASE_MS } from '../src/services/town/townCarry.js';

const token = 'carry-test-00000001';
function fixture() {
  const agent = { actorId: 'actor-a', agentKey: 'npc:1', x: 1, y: 1, slotKey: '1,1',
    path: [{ x: 2, y: 1 }], encounterId: null, chatHoldUntil: 0 };
  const map = { version: 1, walkGrid: Array.from({ length: 6 }, () => Array(6).fill(1)) };
  const occupied = new Map([['1,1', 'npc:1']]);
  const calls = [];
  let now = 1000;
  const perform = (operation, extra = {}) => carryTownResident({ agent, map, occupied,
    token, operation, now, advance: () => calls.push('advance'),
    interrupt: () => calls.push('interrupt'), persist: () => calls.push('persist'),
    stop: a => {
      if (occupied.get(a.slotKey) === a.agentKey) occupied.delete(a.slotKey);
      a.path = null; a.slotKey = `${a.x},${a.y}`; occupied.set(a.slotKey, a.agentKey);
    }, ...extra });
  return { agent, map, occupied, calls, perform, clock: t => { now = t } };
}
test('pickup stops walking, leaves authoritative position at origin and validated drop persists once', () => {
  const f = fixture();
  assert.equal(f.perform('begin').ok, true);
  assert.equal(isTownCarried(f.agent, 1000), true);
  assert.deepEqual([f.agent.x, f.agent.y, f.agent.path], [1, 1, null]);
  assert.equal(f.perform('begin').ok, true, 'same token is idempotent');
  assert.equal(f.calls.filter(c => c === 'interrupt').length, 1);
  assert.equal(f.perform('drop', { x: 4, y: 3 }).returned, false);
  assert.deepEqual([f.agent.x, f.agent.y], [4, 3]);
  assert.equal(f.occupied.has('1,1'), false);
  assert.equal(f.occupied.get('4,3'), 'npc:1');
  assert.equal(f.perform('drop', { x: 5, y: 5 }).ok, false, 'replayed release cannot move resident twice');
});
test('wall, outside, fractional, occupied and disconnected drops return safely to origin', () => {
  for (const kind of ['wall', 'outside', 'fraction', 'occupied', 'player', 'island']) {
    const f = fixture(); f.perform('begin');
    const extra = { x: 4, y: 3 };
    if (kind === 'wall') f.map.walkGrid[3][4] = 0;
    if (kind === 'outside') extra.x = -1;
    if (kind === 'fraction') extra.x = 1.3;
    if (kind === 'occupied') f.occupied.set('4,3', 'npc:2');
    if (kind === 'player') extra.player = { x: 4, y: 3 };
    if (kind === 'island') for (const row of f.map.walkGrid) row[2] = 0;
    const result = f.perform('drop', extra);
    assert.equal(result.returned, true, kind);
    assert.deepEqual(result.position, { x: 1, y: 1 }, kind);
    assert.equal(isTownCarried(f.agent, 1000), false, kind);
  }
});
test('leases reject competing clients, expire after disconnect and fence rebuilt maps', () => {
  const f = fixture(); f.perform('begin');
  const other = { token: 'another-client-00002' };
  for (const op of ['begin', 'renew', 'drop', 'cancel']) assert.equal(f.perform(op, other).ok, false);
  f.clock(1000 + CARRY_LEASE_MS + 1);
  assert.equal(isTownCarried(f.agent, 1000 + CARRY_LEASE_MS + 1), false);
  assert.equal(f.perform('drop', { x: 3, y: 3 }).ok, false);
  assert.equal(f.perform('begin', other).ok, true);
  f.map.version++;
  assert.equal(f.perform('drop', { ...other, x: 3, y: 3 }).ok, false);
  assert.deepEqual([f.agent.x, f.agent.y], [1, 1]);
});
test('cancel releases without relocation, sleeping and chatting residents cannot be picked up', () => {
  const f = fixture(); f.perform('begin');
  assert.equal(f.perform('cancel').returned, true);
  for (const patch of [{ sleeping: true }, { encounterId: 1 }, { chatHoldUntil: 2000 }]) {
    const g = fixture(); Object.assign(g.agent, patch);
    assert.equal(g.perform('begin').code, 'ACTOR_BUSY');
    assert.equal(g.agent.carry, undefined);
  }
});
