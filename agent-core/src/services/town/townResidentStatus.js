/**
 * 居民详细状态（只读展示层，T11 §8.2）：对话框「状态」页签的数据源。
 *
 * 全部是已落库的服务端事实：六类需求、心情（需求+影响项综合）、在册目标与进度、
 * 技能/习惯等级、最近有关系的人（有向关系）。不展示隐藏的评分/数据库身份，
 * 也不给普通玩家堆调试信息；缺档居民返回空骨架而非报错。
 */
import { getDb } from '../../db/index.js';
import { createTownActorRegistry } from './townActorRegistry.js';
import { createTownNeedsService } from './townNeedsService.js';
import { createTownRelationshipService } from './townRelationshipService.js';
import { createResolver } from './townActivityFeed.js';
import { config } from '../../config.js';

const NEED_LABELS = Object.freeze({
  satiety: '饱食', energy: '精力', social: '社交', fun: '娱乐', comfort: '舒适', security: '安全感',
});
const SKILL_LABELS = Object.freeze({
  service: '经营服务', reading: '阅读', social: '社交', service_habit: '上工习惯',
  reader: '阅读习惯', sociable: '社交习惯', foodie: '好胃口习惯',
});

const moodLabel = mood => mood >= 0.35 ? '心情不错' : mood >= 0.1 ? '还算平静' : mood > -0.1 ? '平平常常'
  : mood > -0.35 ? '有点低落' : '很低落';

/**
 * @param {object} input
 * @param {object} input.db  better-sqlite3 连接
 * @param {object} input.registry townActorRegistry
 */
export function createTownResidentStatus({ db, registry }) {
  if (!db?.prepare || !registry?.getActor) throw new TypeError('townResidentStatus missing dependency');
  const needsService = createTownNeedsService({ db, needsConfig: config.town.needs });
  const relationshipService = createTownRelationshipService({ db, socialConfig: config.town.social });

  function ofActor(actorId) {
    const world = registry.getWorldState();
    const resolve = createResolver(db, registry, world.worldId);
    const actor = resolve.actor(actorId);
    const needs = needsService.getNeeds(world.worldId, actorId, Date.now());
    // 没有需求档案（未知/未参与模拟的居民）时不编造心情——computeMood 会用默认满值兜底，
    // 那会让空骨架看起来「心情不错」
    const mood = needs ? needsService.computeMood({ worldId: world.worldId, actorId, nowUtcMs: Date.now() }) : null;

    const goals = db.prepare(`SELECT slot, title, status, progress, spec_json FROM town_resident_goals
      WHERE world_id = ? AND actor_id = ? AND status IN ('active','completed')
      ORDER BY slot LIMIT 3`).all(world.worldId, actorId)
      .map(row => ({ slot: row.slot, title: row.title, status: row.status,
        progress: Math.round(row.progress),
        amount: JSON.parse(row.spec_json || '{}').amount ?? null }));

    const skills = db.prepare(`SELECT key, kind, level FROM town_resident_skills
      WHERE world_id = ? AND actor_id = ? AND level > 0 ORDER BY level DESC LIMIT 6`)
      .all(world.worldId, actorId)
      .map(row => ({ key: row.key, kind: row.kind, label: SKILL_LABELS[row.key] || row.key,
        level: Math.round(row.level) }));

    // 最近有来往的人：按熟悉度 + 好感排序，取前 3（熟人/好感才有展示价值）
    const outgoing = [...relationshipService.listOutgoing(world.worldId, actorId)]
      .map(([otherId, rel]) => ({ ...rel, name: resolve.actor(otherId).name }))
      .filter(rel => rel.familiarity > 0 || rel.affection !== 0)
      .sort((a, b) => (b.familiarity + Math.max(0, b.affection)) - (a.familiarity + Math.max(0, a.affection)))
      .slice(0, 3)
      .map(rel => ({ name: rel.name, familiarity: Math.round(rel.familiarity),
        affection: Math.round(rel.affection) }));

    return {
      actorId,
      name: actor.name,
      needs: needs ? Object.fromEntries(Object.entries(NEED_LABELS)
        .map(([key, label]) => [key, { label, value: Math.round(needs[key] ?? 100) }])) : null,
      mood: mood ? { value: Number(mood.mood.toFixed(2)), label: moodLabel(mood.mood) } : null,
      goals, skills, relationships: outgoing,
    };
  }

  return { ofActor };
}

/** 请求级入口（与 routes/town.js 其他读接口同款惰性构造）。 */
export function getTownResidentStatus() {
  const db = getDb();
  return createTownResidentStatus({ db, registry: createTownActorRegistry(db) });
}
