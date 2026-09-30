/**
 * M5：长期目标、技能与习惯（town-update.md §6.6）。
 *
 * 纯同步规则层。每个居民最多 1 个主目标（slot 0）+ 2 个近期愿望（slot 1/2），
 * 目标从本地规则目录挑选（检查职业/兴趣等可达条件，不生成无法完成的目标），
 * 按本地日挑选（游标表防逐 tick 重选）。进度只从**已结算事实**消费（与 M0-M4
 * 的效果结算同一批来源），完成/受阻/替换都有明确状态；完成后不重复结算奖励。
 *
 * 技能来自有效行为，每日收益有上限且随等级边际递减；习惯只增加决策倾向，
 * 不覆盖紧急需求或明确承诺。
 */
import { createHash } from 'node:crypto';

const GOAL_STATUSES = new Set(['active', 'completed', 'blocked', 'replaced']);
const PROGRESS_KINDS = new Set(['work', 'read', 'eat', 'social', 'wage']);

/** 本地目标目录：type → { title, spec }，挑选时按 validity 过滤。 */
const GOAL_CATALOG = {
  career: { title: '把工作做得更熟练', amount: 30 },
  life: { title: '攒下一笔零花钱', amount: 100 },
  social: { title: '和邻居熟络起来', amount: 30 },
  interest_read: { title: '养成阅读习惯', amount: 20 },
  interest_eat: { title: '练出一副好胃口', amount: 20 },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));

/**
 * @param {object} input
 * @param {object} input.db         better-sqlite3 连接
 * @param {object} input.goalConfig config.town.goals
 */
export function createTownGoalService({ db, goalConfig }) {
  if (!db?.prepare || !goalConfig) throw new TypeError('townGoalService missing dependency');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
  // 进度去重（进程内）：同一动作的同一进度来源不重复计入；跨进程由结算侧幂等保证
  const progressDedupe = new Map();
  function progressSeen(worldId) {
    let set = progressDedupe.get(worldId);
    if (!set) { set = new Set(); progressDedupe.set(worldId, set); }
    return set;
  }

  const stmts = {
    goals: {
      list: db.prepare('SELECT * FROM town_resident_goals WHERE world_id = ? AND actor_id = ? ORDER BY slot'),
      get: db.prepare('SELECT * FROM town_resident_goals WHERE world_id = ? AND actor_id = ? AND slot = ?'),
      upsert: db.prepare(`INSERT INTO town_resident_goals
        (world_id, actor_id, slot, type, title, spec_json, status, progress, created_utc_ms, updated_utc_ms)
        VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)
        ON CONFLICT(world_id, actor_id, slot) DO UPDATE SET
          type = excluded.type, title = excluded.title, spec_json = excluded.spec_json,
          status = 'active', progress = 0, updated_utc_ms = excluded.updated_utc_ms`),
      setStatus: db.prepare(`UPDATE town_resident_goals SET status = ?, updated_utc_ms = ?
        WHERE world_id = ? AND actor_id = ? AND slot = ?`),
      addProgress: db.prepare(`UPDATE town_resident_goals SET progress = ?, status = ?, updated_utc_ms = ?
        WHERE world_id = ? AND actor_id = ? AND slot = ?`),
    },
    cursor: {
      get: db.prepare('SELECT last_pick_day FROM town_resident_goal_cursor WHERE world_id = ? AND actor_id = ?'),
      set: db.prepare(`INSERT INTO town_resident_goal_cursor (world_id, actor_id, last_pick_day) VALUES (?, ?, ?)
        ON CONFLICT(world_id, actor_id) DO UPDATE SET last_pick_day = excluded.last_pick_day`),
    },
    skills: {
      get: db.prepare('SELECT * FROM town_resident_skills WHERE world_id = ? AND actor_id = ? AND key = ?'),
      upsert: db.prepare(`INSERT INTO town_resident_skills (world_id, actor_id, key, kind, level, daily_gain, daily_day)
        VALUES (?, ?, ?, ?, 0, 0, 0)
        ON CONFLICT(world_id, actor_id, key) DO NOTHING`),
      update: db.prepare(`UPDATE town_resident_skills SET level = ?, daily_gain = ?, daily_day = ?
        WHERE world_id = ? AND actor_id = ? AND key = ?`),
      list: db.prepare('SELECT * FROM town_resident_skills WHERE world_id = ? AND actor_id = ?'),
    },
  };

  function readGoals(worldId, actorId) {
    return stmts.goals.list.all(worldId, actorId).map(row => ({
      slot: row.slot, type: row.type, title: row.title, status: row.status,
      progress: row.progress, spec: JSON.parse(row.spec_json || '{}'),
    }));
  }

  /** 有效性检查：职业目标需要工作地点；兴趣目标需要对应兴趣标签；其余恒可达成。 */
  function candidatesFor(profile, context) {
    const interests = profile?.interests ?? [];
    const list = [];
    if (context?.hasWorkplace) list.push('career');
    list.push('life', 'social');
    if (interests.includes('阅读')) list.push('interest_read');
    if (interests.includes('料理')) list.push('interest_eat');
    return list;
  }

  /**
   * 按本地日确保目标在册：完成/受阻的槽位换新目标；active 的保留（不重复结算奖励）。
   * 每居民每本地日最多评估一次。
   */
  function ensureGoals({ worldId, actorId, profile, context, localDay, nowUtcMs }) {
    if (!Number.isSafeInteger(localDay)) throw new TypeError('localDay must be safe integer');
    const cursor = stmts.cursor.get.get(worldId, actorId);
    if (cursor && cursor.last_pick_day >= localDay) return readGoals(worldId, actorId);
    stmts.cursor.set.run(worldId, actorId, localDay);

    const valid = candidatesFor(profile, context);
    const existing = stmts.goals.list.all(worldId, actorId);
    for (const row of existing) {
      // 条件失效（如工作地点消失）的活跃目标标记受阻；完成的保持完成
      if (row.status === 'active' && !valid.includes(row.type)) {
        stmts.goals.setStatus.run('blocked', nowUtcMs, worldId, actorId, row.slot);
      }
    }
    // 三个槽位各挑一个不重复的候选（主目标优先职业/生活，愿望优先兴趣/社交）
    const used = new Set(existing.filter(r => r.status === 'active' && valid.includes(r.type)).map(r => r.type));
    const preference = [
      ['career', 'life', 'social', 'interest_read', 'interest_eat'],   // slot 0
      ['interest_read', 'interest_eat', 'social', 'life', 'career'],   // slot 1
      ['interest_eat', 'interest_read', 'life', 'social', 'career'],   // slot 2
    ];
    for (let slot = 0; slot < 3; slot++) {
      const current = stmts.goals.get.get(worldId, actorId, slot);
      if (current && current.status === 'active') continue;
      const options = preference[slot].filter(type => valid.includes(type) && !used.has(type));
      if (options.length === 0) continue;
      const type = options[dayHash(worldId, actorId, localDay, slot) % options.length];
      used.add(type);
      const spec = { amount: GOAL_CATALOG[type].amount };
      if (type === 'life') spec.savings = GOAL_CATALOG.life.amount;
      stmts.goals.upsert.run(worldId, actorId, slot, type, GOAL_CATALOG[type].title,
        JSON.stringify(spec), nowUtcMs, nowUtcMs);
    }
    return readGoals(worldId, actorId);
  }

  /** 确定性挑选哈希：同 (world, actor, day, slot) 恒定。 */
  function dayHash(worldId, actorId, localDay, slot) {
    const digest = createHash('sha256')
      .update(JSON.stringify(['town.goal.pick', worldId, actorId, localDay, slot])).digest();
    return digest.readUInt32BE(0);
  }

  function getActiveGoals(worldId, actorId) {
    return readGoals(worldId, actorId).filter(g => g.status === 'active');
  }

  /**
   * 消费已结算事实推进目标与技能。同一来源键幂等（不重复计入）；
   * 技能每日收益有上限并随等级边际递减。
   * @param {'work'|'read'|'eat'|'social'|'wage'} kind
   */
  function applyProgress({ worldId, actorId, sourceKey, kind, amount, nowUtcMs, localDay }) {
    if (!PROGRESS_KINDS.has(kind)) return;
    if (!sourceKey || !Number.isFinite(amount) || amount <= 0) return;
    const seen = progressSeen(worldId);
    const dedupeKey = `${actorId}|${sourceKey}|${kind}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const cfg = goalConfig;
    // 目标进度
    for (const goal of stmts.goals.list.all(worldId, actorId)) {
      if (goal.status !== 'active') continue;
      const spec = JSON.parse(goal.spec_json || '{}');
      let delta = 0;
      if (kind === 'work' && goal.type === 'career') delta = cfg.careerProgressPerShift;
      else if (kind === 'read' && goal.type === 'interest_read') delta = cfg.readProgress;
      else if (kind === 'eat' && goal.type === 'interest_eat') delta = cfg.eatInterestProgress;
      else if (kind === 'social' && goal.type === 'social') delta = Math.min(amount, 10);
      else if (kind === 'wage' && goal.type === 'life') delta = amount;
      if (delta <= 0) continue;
      const next = clamp(goal.progress + delta, 0, spec.amount ?? 100);
      const done = next >= (spec.amount ?? 100);
      stmts.goals.addProgress.run(next, done ? 'completed' : 'active', nowUtcMs,
        worldId, actorId, goal.slot);
    }
    // 技能与习惯
    const gains = {
      work: [['service', 'skill', cfg.skillBase], ['service_habit', 'habit', cfg.habitBase]],
      read: [['reading', 'skill', cfg.skillBase], ['reader', 'habit', cfg.habitBase]],
      social: [['social', 'skill', cfg.skillBase], ['sociable', 'habit', cfg.habitBase]],
      eat: [['foodie', 'habit', cfg.habitBase]],
      wage: [],
    }[kind] ?? [];
    for (const [key, kindTag, base] of gains) {
      gainSkill({ worldId, actorId, key, kind: kindTag, base, nowUtcMs, localDay });
    }
  }

  function gainSkill({ worldId, actorId, key, kind, base, nowUtcMs, localDay }) {
    stmts.skills.upsert.run(worldId, actorId, key, kind);
    const row = stmts.skills.get.get(worldId, actorId, key);
    const day = Number.isSafeInteger(localDay) ? localDay : dayNumber(nowUtcMs);
    const dailyGain = row.daily_day === day ? row.daily_gain : 0;
    if (dailyGain >= goalConfig.skillDailyCap) return; // 每日收益上限
    // 边际递减：等级越高收益越低（下限 25%）
    const gain = base * Math.max(0.25, 1 - row.level / 120);
    const applied = Math.min(gain, goalConfig.skillDailyCap - dailyGain);
    stmts.skills.update.run(clamp(row.level + applied, 0, 100), dailyGain + applied, day,
      worldId, actorId, key);
  }

  /** 决策偏置：兴趣目标与习惯 → 生活动作分数加成（目标改变下一步行动评分）。 */
  function getDecisionBias(worldId, actorId) {
    const bias = { eat: 0, read: 0, sit: 0 };
    for (const goal of stmts.goals.list.all(worldId, actorId)) {
      if (goal.status !== 'active') continue;
      if (goal.type === 'interest_read') bias.read += goalConfig.interestGoalBonus;
      if (goal.type === 'interest_eat') bias.eat += goalConfig.interestGoalBonus;
    }
    for (const row of stmts.skills.list.all(worldId, actorId)) {
      if (row.kind !== 'habit') continue;
      if (row.key === 'reader') bias.read += row.level * goalConfig.habitBonusScale;
      if (row.key === 'foodie') bias.eat += row.level * goalConfig.habitBonusScale;
    }
    return bias;
  }

  return { ensureGoals, getActiveGoals, applyProgress, getDecisionBias };
}
