/**
 * 居民目录（只读解析）：actorId → 展示名 / 所属地图，以及 (mapId, locationKey) → 地点名。
 *
 * 活动流水与居民状态共用这一份口径，避免各自实现（历史上 townActivityFeed 里私有一份、
 * 状态服务再 import 一次，重写时容易漏改）。纯查询、无副作用，带请求级缓存。
 */
export function createActorDirectory({ db, registry, worldId }) {
  if (!db?.prepare || !registry?.getActor) throw new TypeError('townActorDirectory missing dependency');
  const actorCache = new Map();
  const locationCache = new Map();
  return {
    /** @returns {{name: string, mapId: number|null}} */
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
      if (!key || mapId == null) return null;
      const cacheKey = `${mapId}:${key}`;
      if (locationCache.has(cacheKey)) return locationCache.get(cacheKey);
      const name = db.prepare('SELECT name FROM town_locations WHERE map_id = ? AND key = ?').get(mapId, key)?.name || null;
      locationCache.set(cacheKey, name);
      return name;
    },
  };
}
