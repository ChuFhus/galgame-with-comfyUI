/**
 * M3：有向关系与普通社交结算（town-update.md §6.4）。
 *
 * 纯同步规则层。A 对 B 与 B 对 A 分开保存；关系变化必须能追溯到已结算来源
 * （source_key 幂等，同一来源同一方向只生效一次），重复事件与刷互动受
 * 「每人每对每日熟悉度上限」约束，不产生无限关系收益。
 *
 * 关系反馈：familiarity/affection 通过 relationshipEncounterFactor 进入下一次
 * 相遇判定（越熟越容易碰面），保证关系数值影响下一步决策而非装饰性数字。
 *
 * 身份口径：只对「在册活身份」（非 archived、非 mergedInto）结算；合并/退役
 * 身份的历史行保留、不复制、不迁移到新身份（§10.1.6 的完整合并策略后续细化）。
 */

const RELATIONSHIP_KEYS = Object.freeze(['familiarity', 'affection', 'trust', 'conflict']);

const clampRange = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));

/** 关系 → 相遇倾向因子：越熟越愿意碰面；好感为正再加成；夹在 [0.5, 3]。 */
export function relationshipEncounterFactor(rel) {
  const familiarity = clampRange(rel?.familiarity ?? 0, 0, 100);
  const affection = clampRange(rel?.affection ?? 0, -100, 100);
  const factor = 1 + familiarity / 100 + (affection > 0 ? affection / 200 : 0);
  return clampRange(factor, 0.5, 3);
}

/**
 * @param {object} input
 * @param {object} input.db          better-sqlite3 连接
 * @param {object} input.socialConfig config.town.social（增量表/每日上限）
 */
export function createTownRelationshipService({ db, socialConfig }) {
  if (!db?.prepare || !socialConfig) throw new TypeError('townRelationshipService missing dependency');

  const stmts = {
    get: db.prepare('SELECT * FROM town_actor_relationships WHERE world_id = ? AND from_actor_id = ? AND to_actor_id = ?'),
    insert: db.prepare(`INSERT INTO town_actor_relationships
      (world_id, from_actor_id, to_actor_id, familiarity, affection, trust, conflict, version, updated_at_utc_ms)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?) ON CONFLICT(world_id, from_actor_id, to_actor_id) DO NOTHING`),
    update: db.prepare(`UPDATE town_actor_relationships
      SET familiarity = ?, affection = ?, trust = ?, conflict = ?, version = version + 1, updated_at_utc_ms = ?
      WHERE world_id = ? AND from_actor_id = ? AND to_actor_id = ?`),
    recordEffect: db.prepare(`INSERT OR IGNORE INTO town_relationship_effects
      (world_id, from_actor_id, to_actor_id, source_key, effects_json, applied_at_utc_ms) VALUES (?, ?, ?, ?, ?, ?)`),
    countTodayEffects: db.prepare(`SELECT count(*) n FROM town_relationship_effects
      WHERE world_id = ? AND from_actor_id = ? AND to_actor_id = ?
      AND applied_at_utc_ms >= ? AND applied_at_utc_ms < ?`),
    listFor: db.prepare('SELECT * FROM town_actor_relationships WHERE world_id = ? AND from_actor_id = ?'),
  };

  const dayWindow = nowUtcMs => {
    const dayStart = Math.floor(nowUtcMs / 86400000) * 86400000;
    return [dayStart, dayStart + 86400000];
  };

  function getRelationship(worldId, fromActorId, toActorId) {
    const row = stmts.get.get(worldId, fromActorId, toActorId);
    return row ? { familiarity: row.familiarity, affection: row.affection, trust: row.trust,
      conflict: row.conflict, version: row.version } : null;
  }

  /** 批量读取某居民的出向关系（相遇概率修正用）。 */
  function listOutgoing(worldId, fromActorId) {
    const map = new Map();
    for (const row of stmts.listFor.all(worldId, fromActorId)) {
      map.set(row.to_actor_id, { familiarity: row.familiarity, affection: row.affection,
        trust: row.trust, conflict: row.conflict });
    }
    return map;
  }

  /**
   * 结算一条有向关系增量。以 (world, from, to, source_key) 幂等；熟悉度增量受
   * 每日上限约束（按效果行数计当日已生效次数），超限的来源被跳过（不记账）。
   * @returns {boolean} 本次是否实际生效
   */
  function applyRelationshipEffects({ worldId, fromActorId, toActorId, sourceKey, effects, nowUtcMs }) {
    if (fromActorId === toActorId) return false;
    if (!sourceKey || !effects || !RELATIONSHIP_KEYS.some(k => Number.isFinite(effects[k]))) return false;
    if (!Number.isSafeInteger(nowUtcMs)) throw new TypeError('nowUtcMs must be safe integer ms');
    const [dayStart, dayEnd] = dayWindow(nowUtcMs);
    const cap = socialConfig.dailyFamiliarityCap;
    if (Number.isFinite(effects.familiarity) && effects.familiarity > 0 && cap > 0) {
      const today = stmts.countTodayEffects.get(worldId, fromActorId, toActorId, dayStart, dayEnd).n;
      if (today >= cap) return false;
    }
    const inserted = stmts.recordEffect.run(worldId, fromActorId, toActorId, sourceKey,
      JSON.stringify(effects), nowUtcMs);
    if (inserted.changes === 0) return false;
    stmts.insert.run(worldId, fromActorId, toActorId, nowUtcMs);
    const row = stmts.get.get(worldId, fromActorId, toActorId);
    const next = {
      familiarity: clampRange(row.familiarity + (Number.isFinite(effects.familiarity) ? effects.familiarity : 0), 0, 100),
      affection: clampRange(row.affection + (Number.isFinite(effects.affection) ? effects.affection : 0), -100, 100),
      trust: clampRange(row.trust + (Number.isFinite(effects.trust) ? effects.trust : 0), 0, 100),
      conflict: clampRange(row.conflict + (Number.isFinite(effects.conflict) ? effects.conflict : 0), 0, 100),
    };
    stmts.update.run(next.familiarity, next.affection, next.trust, next.conflict, nowUtcMs,
      worldId, fromActorId, toActorId);
    return true;
  }

  /** 双向结算一次相遇/共同经历（A→B 与 B→A 各一条，方向对称同量）。 */
  function applyMutualEffects({ worldId, actorIds, sourceKey, effects, nowUtcMs }) {
    if (!Array.isArray(actorIds) || actorIds.length !== 2 || new Set(actorIds).size !== 2) return false;
    const [a, b] = actorIds;
    const forward = applyRelationshipEffects({ worldId, fromActorId: a, toActorId: b, sourceKey, effects, nowUtcMs });
    const backward = applyRelationshipEffects({ worldId, fromActorId: b, toActorId: a, sourceKey, effects, nowUtcMs });
    return forward || backward;
  }

  return { getRelationship, listOutgoing, applyRelationshipEffects, applyMutualEffects };
}
