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
import { createActorDirectory } from './townActorDirectory.js';
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
    const directory = createActorDirectory({ db, registry, worldId: world.worldId });
    const actor = directory.actor(actorId);
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
      .map(([otherId, rel]) => ({ ...rel, name: directory.actor(otherId).name }))
      .filter(rel => rel.familiarity > 0 || rel.affection !== 0)
      .sort((a, b) => (b.familiarity + Math.max(0, b.affection)) - (a.familiarity + Math.max(0, a.affection)))
      .slice(0, 3)
      .map(rel => ({ name: rel.name, familiarity: Math.round(rel.familiarity),
        affection: Math.round(rel.affection) }));

    // 今日日程：NPC 人格里程碑里的作息段（几点做什么）——居民最直接的「日程」来源
    let routine = [];
    try {
      const npcId = db.prepare(`SELECT npc_id FROM town_actors WHERE actor_id = ?`).get(actorId)?.npc_id;
      if (npcId) {
        const raw = db.prepare('SELECT routine_json FROM town_npcs WHERE id = ?').get(npcId)?.routine_json;
        routine = (JSON.parse(raw || '[]') || [])
          .filter(slot => slot && typeof slot.start === 'string' && typeof slot.end === 'string' && slot.activity)
          .slice(0, 12)
          .map(slot => ({ start: slot.start, end: slot.end, activity: String(slot.activity),
            locationKey: slot.locationKey || null }));
      }
    } catch { routine = []; }

    return {
      actorId,
      name: actor.name,
      routine,
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
