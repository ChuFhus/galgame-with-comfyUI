/**
 * M6：规则事件导演（town-update.md §6.7）。
 *
 * 只能从**已经结算的真实条件**建立候选（库存见底、目标达成、关系里程碑），
 * repeat_key 幂等：同一问题不会每天生成一份新委托。候选有有效期；条件消失即
 * 自行处理（handled），过期未处理即关闭（expired）——居民始终有合理后续，
 * 玩家不参与不产生任何惩罚。邀请节奏受每日上限与最小间隔约束（防止连续高压力）。
 *
 * 邀请的呈现复用既有镇民奇遇管线（townNpcEventGenerator 的 ambient 事件），
 * 仅在聚焦图 + 自动 LLM 开启时消耗模型；候选本身的建立与关闭零模型。
 */

const KIND_IMPORTANCE = Object.freeze({
  stockout: 60,     // 餐食见底：影响居民吃饭，经营也停收入
  goal_done: 80,    // 目标达成：值得庆祝的正面事件
  friendship: 50,   // 关系里程碑：两位居民熟络起来
});

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));

/**
 * @param {object} input
 * @param {object} input.db            better-sqlite3 连接
 * @param {object} input.directorConfig config.town.director
 */
export function createTownDirectorService({ db, directorConfig }) {
  if (!db?.prepare || !directorConfig) throw new TypeError('townDirectorService missing dependency');

  const stmts = {
    insert: db.prepare(`INSERT OR IGNORE INTO town_director_candidates
      (world_id, repeat_key, kind, map_id, payload_json, importance, status, created_utc_ms, expires_at_utc_ms, updated_utc_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`),
    setStatus: db.prepare(`UPDATE town_director_candidates SET status = ?, updated_utc_ms = ?
      WHERE world_id = ? AND repeat_key = ?`),
    get: db.prepare('SELECT * FROM town_director_candidates WHERE world_id = ? AND repeat_key = ?'),
    listOpen: db.prepare(`SELECT * FROM town_director_candidates WHERE world_id = ? AND status = 'open'
      ORDER BY importance DESC, created_utc_ms ASC`),
    invitedToday: db.prepare(`SELECT count(*) n FROM town_director_candidates WHERE world_id = ?
      AND status = 'invited' AND created_utc_ms >= ?`),
    expireDue: db.prepare(`UPDATE town_director_candidates SET status = 'expired', updated_utc_ms = ?
      WHERE world_id = ? AND status IN ('open','invited') AND expires_at_utc_ms <= ?`),
    autoResolve: db.prepare(`UPDATE town_director_candidates SET status = 'handled', updated_utc_ms = ?
      WHERE world_id = ? AND repeat_key = ? AND status = 'open'`),
    countOpenByKind: db.prepare(`SELECT count(*) n FROM town_director_candidates WHERE world_id = ?
      AND kind = ? AND status IN ('open','invited')`),
  };

  /** 建立候选（幂等）：同一 repeat_key 已存在时静默跳过。 */
  function propose({ worldId, repeatKey, kind, mapId = null, payload = {}, nowUtcMs }) {
    const importance = clampInt(KIND_IMPORTANCE[kind] ?? 40, 0, 100);
    const expires = nowUtcMs + directorConfig.candidateTtlMs;
    const result = stmts.insert.run(worldId, repeatKey, kind, mapId, JSON.stringify(payload ?? {}),
      importance, nowUtcMs, expires, nowUtcMs);
    return result.changes === 1;
  }

  /** 条件消失 → 自行处理（居民已有合理后续，如补货恢复）。 */
  function resolve({ worldId, repeatKey, nowUtcMs }) {
    stmts.autoResolve.run(nowUtcMs, worldId, repeatKey);
  }

  /** 到期关闭（不做任何惩罚）。 */
  function expireDue({ worldId, nowUtcMs }) {
    stmts.expireDue.run(nowUtcMs, worldId, nowUtcMs);
  }

  /**
   * 挑选下一个值得发出邀请的候选（importance 降序）；节奏受每日上限与最小间隔约束。
   * @returns {object|null} 候选行（调用方负责置为 invited 并生成邀请演出）
   */
  function nextInvite({ worldId, nowUtcMs }) {
    if (directorConfig.inviteDailyCap > 0) {
      const dayStart = Math.floor(nowUtcMs / 86400000) * 86400000;
      if (stmts.invitedToday.get(worldId, dayStart).n >= directorConfig.inviteDailyCap) return null;
    }
    const candidates = stmts.listOpen.all(worldId);
    for (const candidate of candidates) {
      if (nowUtcMs - candidate.created_utc_ms < directorConfig.inviteGapMs) continue;
      return candidate;
    }
    return null;
  }

  function markInvited({ worldId, repeatKey, nowUtcMs }) {
    stmts.setStatus.run('invited', nowUtcMs, worldId, repeatKey);
  }

  /** 同类活跃候选去重查询（例如已有活跃的缺货委托时不重复催办）。 */
  function hasOpenKind({ worldId, kind }) {
    return stmts.countOpenByKind.get(worldId, kind).n > 0;
  }

  return { propose, resolve, expireDue, nextInvite, markInvited, hasOpenKind,
    get: ({ worldId, repeatKey }) => stmts.get.get(worldId, repeatKey) ?? null };
}
