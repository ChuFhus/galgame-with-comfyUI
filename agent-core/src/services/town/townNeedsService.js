/**
 * M1：居民需求、性格与情绪（town-update.md §6.2）。
 *
 * 纯同步规则层：无 LLM、无网络。需求按「实际经过的逻辑时间」结算（调用方显式传
 * nowUtcMs，注入时钟），与 tick 次数、页面刷新、分批处理无关；衰减速率、恢复量、
 * 影响项参数集中由 config.town.needs 提供。性格档案由本地规则派生（确定性哈希），
 * 不从人格文本逐 tick 推测；manual 来源的档案永不自动改写。
 *
 * 数据归属（同世界持续保存，换地图不重置）：town_resident_profiles /
 * town_resident_needs / town_need_effects（恢复效果来源，保证只生效一次）/
 * town_mood_influences（心情影响项，去重 + 过期 + 边际递减）。
 */
import { createHash } from 'node:crypto';

export const NEED_KEYS = Object.freeze(['satiety', 'energy', 'social', 'fun', 'comfort', 'security']);
const PERSONALITY_KEYS = Object.freeze(['extraversion', 'diligence', 'frugality', 'curiosity', 'friendliness']);

/** 兴趣标签的本地关键词映射（来自职业/简介文本，保守匹配；不匹配则缺省散步）。 */
const INTEREST_KEYWORDS = [
  ['料理', ['料理', '烹饪', '茶', '点心', '厨房']],
  ['阅读', ['书', '阅读', '诗文', '字画']],
  ['手作', ['手作', '木工', '缝纫', '编织', '匠']],
  ['园艺', ['花', '园艺', '种植', '菜']],
  ['散步', []],
];

const clampNeed = value => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
};

/** 确定性性格派生：相同 (worldId, actorId) 恒定；首版取温和区间 0.25~0.75。 */
export function derivePersonality(worldId, actorId) {
  const hash = createHash('sha256').update(JSON.stringify(['town.profile', worldId, actorId])).digest();
  const personality = {};
  PERSONALITY_KEYS.forEach((key, i) => {
    const v = hash[i] / 255;                       // 0..1
    personality[key] = Math.round((0.25 + v * 0.5) * 100) / 100;
  });
  return personality;
}

/** 兴趣派生：按职业/简介关键词保守匹配，全部未命中时给「散步」。 */
export function deriveInterests(text) {
  const source = String(text || '');
  const tags = [];
  for (const [tag, words] of INTEREST_KEYWORDS) {
    if (tag === '散步') continue;
    if (words.some(w => source.includes(w))) tags.push(tag);
  }
  if (tags.length === 0) tags.push('散步');
  return tags;
}

function parsePersonality(json, fallback) {
  try {
    const value = JSON.parse(json);
    if (!value || PERSONALITY_KEYS.some(k => typeof value[k] !== 'number' || !Number.isFinite(value[k]))) return fallback;
    return value;
  } catch { return fallback; }
}

function parseNeeds(json) {
  try {
    const value = JSON.parse(json);
    if (!value) return null;
    const needs = {};
    for (const key of NEED_KEYS) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return null;
      needs[key] = clampNeed(value[key]);
    }
    return needs;
  } catch { return null; }
}

const DEFAULT_NEEDS = Object.freeze(Object.fromEntries(NEED_KEYS.map(k => [k, 100])));

/**
 * @param {object} input
 * @param {object} input.db       better-sqlite3 连接
 * @param {object} input.needsConfig  config.town.needs（衰减/恢复/影响项参数）
 */
export function createTownNeedsService({ db, needsConfig }) {
  if (!db?.prepare || !needsConfig) throw new TypeError('townNeedsService missing dependency');
  const decayPerHour = needsConfig.decayPerHour;
  const influenceCfg = needsConfig.influence;

  const profileStmts = {
    get: db.prepare('SELECT * FROM town_resident_profiles WHERE world_id = ? AND actor_id = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO town_resident_profiles
      (world_id, actor_id, personality_json, interests_json, source, profile_version, updated_at)
      VALUES (?, ?, ?, ?, 'derived', 1, datetime('now'))`),
  };
  const needsStmts = {
    get: db.prepare('SELECT * FROM town_resident_needs WHERE world_id = ? AND actor_id = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO town_resident_needs
      (world_id, actor_id, needs_json, last_settled_utc_ms, version) VALUES (?, ?, ?, ?, 0)`),
    update: db.prepare(`UPDATE town_resident_needs
      SET needs_json = ?, last_settled_utc_ms = ?, version = version + 1 WHERE world_id = ? AND actor_id = ?`),
    bumpEffects: db.prepare(`UPDATE town_resident_needs
      SET needs_json = ?, version = version + 1 WHERE world_id = ? AND actor_id = ?`),
  };
  const effectStmts = {
    insert: db.prepare(`INSERT OR IGNORE INTO town_need_effects
      (world_id, actor_id, source_key, effects_json, applied_at_utc_ms) VALUES (?, ?, ?, ?, ?)`),
  };
  const influenceStmts = {
    get: db.prepare('SELECT * FROM town_mood_influences WHERE world_id = ? AND actor_id = ? AND source_key = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO town_mood_influences
      (world_id, actor_id, source_key, kind, intensity, created_at_utc_ms, expires_at_utc_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    listActive: db.prepare(`SELECT * FROM town_mood_influences WHERE world_id = ? AND actor_id = ?
      AND expires_at_utc_ms > ? ORDER BY created_at_utc_ms`),
    countActive: db.prepare(`SELECT count(*) n FROM town_mood_influences WHERE world_id = ? AND actor_id = ?
      AND expires_at_utc_ms > ?`),
    deleteOldest: db.prepare(`DELETE FROM town_mood_influences WHERE world_id = ? AND actor_id = ? AND source_key = (
      SELECT source_key FROM town_mood_influences WHERE world_id = ? AND actor_id = ? AND expires_at_utc_ms > ?
      ORDER BY created_at_utc_ms LIMIT 1)`),
    deleteExpired: db.prepare(`DELETE FROM town_mood_influences WHERE world_id = ? AND actor_id = ?
      AND expires_at_utc_ms <= ?`),
  };

  function ensureNeedsRow(worldId, actorId, nowUtcMs) {
    needsStmts.insert.run(worldId, actorId, JSON.stringify(DEFAULT_NEEDS), nowUtcMs);
    return needsStmts.get.get(worldId, actorId);
  }

  /**
   * 性格档案：不存在时按确定性规则派生落库（可重复迁移）；manual 档案永不覆盖。
   * @returns {frozen {personality, interests, source, profileVersion}}
   */
  function ensureProfile(worldId, actorId, { jobText = '' } = {}) {
    let row = profileStmts.get.get(worldId, actorId);
    if (!row) {
      profileStmts.insert.run(worldId, actorId,
        JSON.stringify(derivePersonality(worldId, actorId)),
        JSON.stringify(deriveInterests(jobText)));
      row = profileStmts.get.get(worldId, actorId);
    }
    const personality = parsePersonality(row.personality_json, derivePersonality(worldId, actorId));
    let interests = [];
    try { interests = JSON.parse(row.interests_json) || []; } catch { interests = []; }
    return Object.freeze({ personality, interests, source: row.source, profileVersion: row.profile_version });
  }

  /** 批量读取（scanEncounters 用）；不落库，缺档案时回退派生值。 */
  function getProfiles(worldId, actorIds) {
    const map = new Map();
    for (const actorId of actorIds) {
      const row = profileStmts.get.get(worldId, actorId);
      const fallback = derivePersonality(worldId, actorId);
      map.set(actorId, row
        ? { personality: parsePersonality(row.personality_json, fallback), source: row.source }
        : { personality: fallback, source: 'derived' });
    }
    return map;
  }

  /**
   * 按逻辑时间结算需求：衰减量 = 经过小时数 × 各需求速率 × 性格修正，上限 0-100。
   * 离线间隔按上限截断（小镇默认温和：长离线不做不可逆惩罚），游标推进到 now。
   * @returns {frozen needs} 六类满足度
   */
  function settleNeeds(worldId, actorId, nowUtcMs, { personality = null } = {}) {
    if (!Number.isSafeInteger(nowUtcMs)) throw new TypeError('nowUtcMs must be safe integer ms');
    const row = ensureNeedsRow(worldId, actorId, nowUtcMs);
    const needs = parseNeeds(row.needs_json) || { ...DEFAULT_NEEDS };
    const gapMs = Math.max(0, nowUtcMs - row.last_settled_utc_ms);
    if (gapMs > 0) {
      const effectiveHours = Math.min(gapMs, needsConfig.maxSettleGapMs) / 3600_000;
      for (const key of NEED_KEYS) {
        const rate = decayPerHour[key] ?? 0;
        if (rate <= 0) continue;
        let factor = 1;
        if (key === 'social' && personality) {
          // 外向者社交需求衰减更快（更需要陪伴），内向者更慢；性格不取消基本生活约束
          const e = Math.max(0, Math.min(1, personality.extraversion ?? 0.5));
          factor = needsConfig.personalitySocialDecay[0] + (needsConfig.personalitySocialDecay[1] - needsConfig.personalitySocialDecay[0]) * e;
        }
        needs[key] = clampNeed(needs[key] - rate * effectiveHours * factor);
      }
      needsStmts.update.run(JSON.stringify(needs), nowUtcMs, worldId, actorId);
    }
    return Object.freeze(needs);
  }

  function getNeeds(worldId, actorId, nowUtcMs) {
    const row = needsStmts.get.get(worldId, actorId);
    if (!row) return null;
    const needs = parseNeeds(row.needs_json);
    return needs ? Object.freeze(needs) : null;
  }

  /**
   * 应用一次需求效果（M2 行动 / 相遇结算等来源）。
   * 以 (worldId, actorId, sourceKey) 幂等：同一来源只生效一次，重试不重复加分。
   * @returns {boolean} 本次是否实际生效
   */
  function applyNeedEffects({ worldId, actorId, sourceKey, effects, nowUtcMs }) {
    if (!sourceKey || typeof effects !== 'object' || !effects
      || !NEED_KEYS.some(k => Number.isFinite(effects[k]))) return false;
    ensureNeedsRow(worldId, actorId, nowUtcMs);
    const inserted = effectStmts.insert.run(worldId, actorId, sourceKey,
      JSON.stringify(effects), nowUtcMs);
    if (inserted.changes === 0) return false;
    const row = needsStmts.get.get(worldId, actorId);
    const needs = parseNeeds(row.needs_json) || { ...DEFAULT_NEEDS };
    for (const key of NEED_KEYS) {
      if (Number.isFinite(effects[key])) needs[key] = clampNeed(needs[key] + effects[key]);
    }
    needsStmts.bumpEffects.run(JSON.stringify(needs), worldId, actorId);
    return true;
  }

  /**
   * 添加心情影响项：同一 sourceKey 去重；每人活跃影响项有上限（超出淘汰最早一条）；
   * 过期项在写入时顺手清理。强度 -1..1，负值代表糟糕经历。
   * @returns {boolean} 是否新增
   */
  function addMoodInfluence({ worldId, actorId, sourceKey, kind, intensity, nowUtcMs, ttlMs }) {
    if (!sourceKey || !kind || !Number.isFinite(intensity) || intensity < -1 || intensity > 1
      || !Number.isSafeInteger(nowUtcMs) || !Number.isSafeInteger(ttlMs) || ttlMs < 1) return false;
    if (influenceStmts.get.get(worldId, actorId, sourceKey)) return false;
    influenceStmts.deleteExpired.run(worldId, actorId, nowUtcMs);
    const active = influenceStmts.countActive.get(worldId, actorId, nowUtcMs).n;
    if (active >= influenceCfg.activeCap) {
      influenceStmts.deleteOldest.run(worldId, actorId, worldId, actorId, nowUtcMs);
    }
    return influenceStmts.insert.run(worldId, actorId, sourceKey, kind, intensity,
      nowUtcMs, nowUtcMs + ttlMs).changes === 1;
  }

  function listActiveInfluences(worldId, actorId, nowUtcMs) {
    return influenceStmts.listActive.all(worldId, actorId, nowUtcMs)
      .map(row => ({ kind: row.kind, intensity: row.intensity,
        createdAtUtcMs: row.created_at_utc_ms, expiresAtUtcMs: row.expires_at_utc_ms, sourceKey: row.source_key }));
  }

  /**
   * 综合心情：需求基线（均值映射到 -1..1）+ 影响项（同类别边际递减，权重减半每次），
   * 结果夹在 -1..1。只读计算，不回写；聊天情绪（emotion_snapshots）由 townService
   * 独立读取，两者不互相注入，避免循环放大。
   */
  function computeMood({ worldId, actorId, nowUtcMs, personality = null }) {
    const row = needsStmts.get.get(worldId, actorId);
    const needs = (row && parseNeeds(row.needs_json)) || { ...DEFAULT_NEEDS };
    const avg = NEED_KEYS.reduce((sum, k) => sum + needs[k], 0) / NEED_KEYS.length;
    let mood = avg / 50 - 1;
    const influences = listActiveInfluences(worldId, actorId, nowUtcMs);
    const kindCount = new Map();
    for (const item of influences) {
      const seen = kindCount.get(item.kind) ?? 0;
      kindCount.set(item.kind, seen + 1);
      mood += item.intensity / (1 + 0.5 * seen);
    }
    return Object.freeze({
      mood: Math.max(-1, Math.min(1, mood)),
      needs: Object.freeze({ ...needs }),
      influenceCount: influences.length,
    });
  }

  return { ensureProfile, getProfiles, settleNeeds, getNeeds, applyNeedEffects,
    addMoodInfluence, listActiveInfluences, computeMood };
}
