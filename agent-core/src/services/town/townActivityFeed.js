/**
 * 居民活动流水（T11 §8.1/§9.3）：把 town_activity_log 的动作流转翻译成可读文案。
 *
 * 只做只读展示层：数据全部来自已落库的动作记录（JOIN town_actions 拿动作类型/地点），
 * 文案是事实的直述，不推断数值。噪音过滤：wait 类、cancelled、睡觉中的分段 rest
 * 不进信息流；rest 的完成保留在居民个人列表里（「休息好了」）。
 * 地点用居民所在地图的地点名解析，不跨图猜同名 key。
 */
import { getDb } from '../../db/index.js';
import { createTownActorRegistry } from './townActorRegistry.js';

const GLOBAL_PHASES = "('running','completed','failed')";

/** 地点/人名解析的请求级缓存（活动流水与居民状态共用） */
export function createResolver(db, registry, worldId) {
  const actorCache = new Map();
  const locationCache = new Map();
  return {
    actor(actorId) {
      if (actorCache.has(actorId)) return actorCache.get(actorId);
      let info = { name: '居民', mapId: null };
      try {
        const actor = registry.getActor(actorId, worldId, { followMerged: false });
        if (actor?.npcExists) {
          const row = db.prepare('SELECT map_id, display_name FROM town_npcs WHERE id = ?').get(actor.npcId);
          if (row) info = { name: row.display_name || '居民', mapId: row.map_id };
        } else if (actor?.characterExists) {
          const row = db.prepare(`SELECT c.display_name, c.name, tc.map_id FROM characters c
            LEFT JOIN town_characters tc ON tc.character_id = c.character_id WHERE c.id = ?`).get(actor.characterId);
          if (row) info = { name: row.display_name || row.name || '居民', mapId: row.map_id };
        }
      } catch { /* 缺档居民回退默认名 */ }
      actorCache.set(actorId, info);
      return info;
    },
    location(mapId, key) {
      if (!key) return null;
      const cacheKey = `${mapId ?? 'x'}:${key}`;
      if (locationCache.has(cacheKey)) return locationCache.get(cacheKey);
      const name = mapId != null
        ? db.prepare('SELECT name FROM town_locations WHERE map_id = ? AND key = ?').get(mapId, key)?.name || null
        : null;
      locationCache.set(cacheKey, name);
      return name;
    },
  };
}

/** 单条动作记录 → 可读文案；返回 null 表示噪音（不在信息流展示）。 */
export function describeActivity(row, locationName) {
  const where = locationName ? `在${locationName}` : '在镇上';
  const phase = row.phase;
  const type = row.action_type;
  if (row.phase === 'cancelled') return null;
  switch (type) {
    case 'move_to':
      if (phase === 'completed') return `到了${locationName || '目的地'}`;
      if (phase === 'failed') {
        return row.reason_code === 'PATH_UNREACHABLE'
          ? `想去${locationName || '某处'}，但路走不通` : `去${locationName || '某处'}的路上出了岔子`;
      }
      return `动身去${locationName || '某处'}`;
    case 'work_shift':
      if (phase === 'running') return `${where}上工`;
      if (phase === 'completed') return `结束了${locationName ? `在${locationName}` : ''}的工作`;
      return `${where}的班次中断了`;
    case 'rest':
      if (phase === 'completed') return `${where}休息好了`;
      return null; // 睡觉的分段进行中记录不展示
    case 'life_eat':
      if (phase === 'running') return `${where}找吃的`;
      if (phase === 'completed') return `${where}吃了点东西`;
      return `${where}没能吃上饭`;
    case 'life_read':
      if (phase === 'running') return `${where}看书`;
      if (phase === 'completed') return `${where}读了会儿书`;
      return `${where}没看成书`;
    case 'life_sit':
      if (phase === 'running') return `${where}歇脚`;
      if (phase === 'completed') return `${where}坐了一会儿`;
      return null;
    case 'wait':
      return phase === 'running' ? `${where}闲逛` : null;
    default:
      return null;
  }
}

const clampLimit = (value, fallback, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
};

/**
 * @param {object} input
 * @param {object} input.db       better-sqlite3 连接
 * @param {object} input.registry townActorRegistry
 */
export function createTownActivityFeed({ db, registry, dedupeWindowMs = 10 * 60_000 }) {
  if (!db?.prepare || !registry?.getActor) throw new TypeError('townActivityFeed missing dependency');

  function toEntries(rows, worldId) {
    const resolve = createResolver(db, registry, worldId);
    const entries = [];
    const lastKept = new Map();   // actorId -> { text, occurredAt }
    for (const row of rows) {
      const actor = resolve.actor(row.actor_id);
      const locationName = resolve.location(actor.mapId, row.location_key);
      const text = describeActivity(row, locationName);
      if (!text) continue;
      // 降噪：同一居民、同一句文案在窗口内的连续重复（抖动残留/反复取消重试）只保留最新一条，
      // 避免信息流被「动身去 X」刷屏；跨窗口的正常重复不受影响。
      const previous = lastKept.get(row.actor_id);
      if (previous && previous.text === text && previous.occurredAt - row.occurred_at <= dedupeWindowMs) continue;
      lastKept.set(row.actor_id, { text, occurredAt: row.occurred_at });
      entries.push({ seq: row.seq, actorId: row.actor_id, name: actor.name, text,
        occurredAt: row.occurred_at });
    }
    return entries;
  }

  /** 全镇信息流（左上角浮窗 / 动态面板）：排除 wait 与睡觉分段，控制噪音。 */
  function recent({ limit = 40 } = {}) {
    const world = registry.getWorldState();
    const rows = db.prepare(`SELECT l.seq, l.actor_id, l.phase, l.reason_code, l.location_key,
        l.occurred_at, a.type AS action_type
      FROM town_activity_log l JOIN town_actions a ON a.id = l.action_id
      WHERE l.world_id = ? AND l.phase IN ${GLOBAL_PHASES} AND a.type != 'wait'
        AND NOT (a.type = 'rest' AND l.phase = 'running')
      ORDER BY l.seq DESC LIMIT ?`).all(world.worldId, clampLimit(limit, 40, 100));
    return toEntries(rows, world.worldId);
  }

  /** 单个居民的最近行动记录（对话框「动态」页签，默认 100 条）。 */
  function ofActor(actorId, { limit = 100 } = {}) {
    const world = registry.getWorldState();
    if (typeof actorId !== 'string' || !actorId) return [];
    const rows = db.prepare(`SELECT l.seq, l.actor_id, l.phase, l.reason_code, l.location_key,
        l.occurred_at, a.type AS action_type
      FROM town_activity_log l JOIN town_actions a ON a.id = l.action_id
      WHERE l.world_id = ? AND l.actor_id = ? AND l.phase IN ${GLOBAL_PHASES}
      ORDER BY l.seq DESC LIMIT ?`).all(world.worldId, actorId, clampLimit(limit, 100, 200));
    return toEntries(rows, world.worldId);
  }

  return { recent, ofActor };
}

/** 请求级入口（与 routes/town.js 其他读接口同款惰性构造）。 */
export function getTownActivityFeed() {
  const db = getDb();
  return createTownActivityFeed({ db, registry: createTownActorRegistry(db) });
}
