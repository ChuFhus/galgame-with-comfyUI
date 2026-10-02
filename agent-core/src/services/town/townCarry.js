import { isWalkable, findPath } from './townPathfinding.js';

export const CARRY_LEASE_MS = 20_000;
const MAX_CARRY_MS = 120_000;
export const isTownCarried = (agent, now = Date.now()) => !!agent?.carry && agent.carry.expiresAt > now;
const fail = (code, error) => ({ ok: false, code, error });

/** A carry keeps the authoritative resident at its origin until a validated drop.
 * Leases are transient: disconnect/restart never strands a resident in midair.
 * token belongs to one gesture, not to an actor or a browser-wide session.
 */
export function carryTownResident({ agent, map, occupied, player, token, operation, x, y,
  now = Date.now(), advance, stop, interrupt, persist }) {
  if (!agent) return fail('ACTOR_NOT_PRESENT', '这位居民目前不在镇上');
  if (typeof token !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(token)) {
    return fail('INVALID_CARRY_TOKEN', '本次拎起操作已失效');
  }
  const live = isTownCarried(agent, now);
  if (operation === 'begin') {
    if (live) {
      if (agent.carry.token !== token) return fail('ACTOR_CARRIED', '这位居民已经被拎起来了');
      return { ok: true, position: { x: agent.x, y: agent.y } };
    }
    if (agent.sleeping || agent.encounterId != null || agent.chatHoldUntil > now) {
      return fail('ACTOR_BUSY', '这位居民正在休息或交谈，等一会儿再来吧');
    }
    advance(agent, now);
    agent.carry = { token, version: map.version, expiresAt: now + CARRY_LEASE_MS, startedAt: now };
    interrupt(agent);
    stop(agent);
    return { ok: true, position: { x: agent.x, y: agent.y } };
  }
  if (!live || agent.carry.token !== token || agent.carry.version !== map.version) {
    return fail('CARRY_EXPIRED', '拎起已结束，居民已回到原处');
  }
  if (operation === 'renew') {
    agent.carry.expiresAt = Math.min(now + CARRY_LEASE_MS, agent.carry.startedAt + MAX_CARRY_MS);
    if (agent.carry.expiresAt <= now) return fail('CARRY_EXPIRED', '先让这位居民歇一会儿吧');
    return { ok: true };
  }
  if (!['drop', 'cancel'].includes(operation)) return fail('INVALID_OPERATION', '操作无效');
  let rejected = null;
  if (operation === 'drop') {
    const key = `${x},${y}`;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !isWalkable(map.walkGrid, x, y)) {
      rejected = fail('INVALID_DROP', '这里不能落脚，已放回原处');
    } else if ((occupied.has(key) && occupied.get(key) !== agent.agentKey)
      || (player && player.x === x && player.y === y)) {
      rejected = fail('DROP_OCCUPIED', '这里有人，已放回原处');
    } else if (findPath(map.walkGrid, { x: agent.x, y: agent.y }, { x, y }) === null) {
      rejected = fail('DROP_UNREACHABLE', '这里无法走回镇上，已放回原处');
    } else {
      if (occupied.get(agent.slotKey) === agent.agentKey) occupied.delete(agent.slotKey);
      agent.x = x; agent.y = y;
      agent.targetLocId = null;
      agent.pathRetryAt = 0;
      agent.stroll = null; agent.strollWalk = false;
      agent.lifePlan = null;
    }
  }
  agent.carry = null;
  stop(agent);
  persist(agent);
  return { ok: true, position: { x: agent.x, y: agent.y }, returned: operation === 'cancel' || !!rejected,
    message: rejected?.error || null };
}
