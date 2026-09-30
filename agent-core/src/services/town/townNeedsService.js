/**
 * M1：居民需求、性格与情绪（town-update.md §6.2）。
 *
 * 纯同步规则层：无 LLM、无网络。需求按「实际经过的逻辑时间」结算（调用方显式传
 * nowUtcMs，注入时钟），与 tick 次数、页面刷新、分批处理无关；衰减速率、恢复量、
 * 影响项参数集中由 config.town.needs 提供。性格档案由本地规则派生（确定性哈希），
 * 不从人格文本逐 tick 推测；manual 来源的档案永不自动改写。
 *
 * 数据归属（同世界持续保存，换地图不重置）：只有 town_resident_profiles（性格/兴趣）
 * 与 town_resident_needs（六类满足度 + 结算游标）两张表。
 *
 * 精简（2026-09-30）：删掉两张"每件事一行"的表——
 *   town_need_effects：只用来判断"这个来源是否已结算"，全项目无读者，内容与动作行重复；
 *     改为契约式保证：一次结算只由调用方触发一次（动作终态唯一、相遇结算在单事务内）。
 *   town_mood_influences：当前没有生产者（只有"愉快交谈"会写，零模型下不发生），空转机制。
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
   * 应用一次需求效果（M2 行动 / 相遇结算等来源），数值夹在 0—100。
   * 契约：调用方保证同一来源只调用一次——动作完成的结算发生在唯一的完成拍、
   * 相遇结算与经历入账在同一事务内，因此不需要额外的"来源台账"。
   */
  function applyNeedEffects({ worldId, actorId, effects, nowUtcMs }) {
    if (!effects || typeof effects !== 'object' || !NEED_KEYS.some(k => Number.isFinite(effects[k]))) return false;
    ensureNeedsRow(worldId, actorId, nowUtcMs);
    const row = needsStmts.get.get(worldId, actorId);
    const needs = parseNeeds(row.needs_json) || { ...DEFAULT_NEEDS };
    for (const key of NEED_KEYS) {
      if (Number.isFinite(effects[key])) needs[key] = clampNeed(needs[key] + effects[key]);
    }
    needsStmts.bumpEffects.run(JSON.stringify(needs), worldId, actorId);
    return true;
  }

  /**
   * 综合心情：只看需求基线（六类均值映射到 -1..1）。只读计算，不回写；
   * 聊天情绪（emotion_snapshots）由 townService 独立读取，两者不互相注入，避免循环放大。
   */
  function computeMood({ worldId, actorId }) {
    const row = needsStmts.get.get(worldId, actorId);
    const needs = (row && parseNeeds(row.needs_json)) || { ...DEFAULT_NEEDS };
    const avg = NEED_KEYS.reduce((sum, k) => sum + needs[k], 0) / NEED_KEYS.length;
    return Object.freeze({ mood: Math.max(-1, Math.min(1, avg / 50 - 1)), needs: Object.freeze({ ...needs }) });
  }

  return { ensureProfile, getProfiles, settleNeeds, getNeeds, applyNeedEffects, computeMood };
}
