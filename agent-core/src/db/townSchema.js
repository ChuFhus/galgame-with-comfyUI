import { randomUUID, randomBytes } from 'node:crypto';
import { createTownActorRegistry } from '../services/town/townActorRegistry.js';

export const TOWN_SCHEMA_VERSION = 1;

/**
 * Run after the existing town/character schema migrations, with an explicitly
 * supplied better-sqlite3 connection. No file opening or singleton access.
 * DDL, version and identity backfill commit together; errors are not swallowed.
 */
export function migrateTownSchema(db) {
  return db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS town_world_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        world_id TEXT NOT NULL UNIQUE,
        epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch >= 1),
        seed TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS town_actors (
        actor_id TEXT PRIMARY KEY NOT NULL,
        player_id TEXT,
        npc_id INTEGER,
        character_id INTEGER,
        participating INTEGER NOT NULL DEFAULT 0 CHECK (participating IN (0, 1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        merged_into TEXT REFERENCES town_actors(actor_id),
        CHECK (merged_into IS NULL OR (merged_into <> actor_id AND archived = 1 AND participating = 0))
      );
    `);
    // A versioned migration must not silently accept a differently shaped table.
    // Compatible early M0 drafts may lack the additive state fields below.
    for (const [table, required, additions] of [
      ['town_world_state', ['singleton', 'world_id', 'seed'], {
        epoch: 'INTEGER NOT NULL DEFAULT 1 CHECK (epoch >= 1)',
        schema_version: 'INTEGER NOT NULL DEFAULT 0',
      }],
      ['town_actors', ['actor_id', 'player_id', 'npc_id', 'character_id'], {
        participating: 'INTEGER NOT NULL DEFAULT 0 CHECK (participating IN (0, 1))',
        archived: 'INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))',
        merged_into: 'TEXT REFERENCES town_actors(actor_id)',
      }],
      // town_npcs 的必需列刻意只校验 id：极简测试夹具可能省略 map_id 等业务列。
      ['town_npcs', ['id'], {
        next_moment_at: 'DATETIME',
        moments_disabled: 'INTEGER NOT NULL DEFAULT 0',
      }],
    ]) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      for (const name of required) {
        if (!columns.has(name)) throw new Error(`Unsupported ${table} schema: missing ${name}`);
      }
      for (const [name, definition] of Object.entries(additions)) {
        if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
    db.prepare(`INSERT OR IGNORE INTO town_world_state (singleton, world_id, seed)
      VALUES (1, ?, ?)`).run(randomUUID(), randomBytes(16).toString('hex'));
    const version = db.prepare('SELECT schema_version FROM town_world_state WHERE singleton = 1').get().schema_version;
    if (version > TOWN_SCHEMA_VERSION) throw new Error(`Unsupported town schema version ${version}`);
    // Retired identities still reserve their source IDs. Membership changes must
    // never mint a second identity. Only merge tombstones release the mapping.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS town_actors_player_unique ON town_actors(player_id) WHERE merged_into IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS town_actors_npc_unique ON town_actors(npc_id) WHERE merged_into IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS town_actors_character_unique ON town_actors(character_id) WHERE merged_into IS NULL;
    `);
    // M1 生态：居民模拟档案（性格/兴趣）、需求状态与需求效果来源（同世界持续保存，换图不重置）。
    // 全部按 (world_id, actor_id) 主键幂等创建，现有居民无需重新生成人格或形象。
    db.exec(`
      CREATE TABLE IF NOT EXISTS town_resident_profiles (
        world_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        personality_json TEXT NOT NULL,
        interests_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'derived' CHECK (source IN ('derived','manual','llm')),
        profile_version INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME,
        PRIMARY KEY (world_id, actor_id)
      );
      CREATE TABLE IF NOT EXISTS town_resident_needs (
        world_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        needs_json TEXT NOT NULL,
        last_settled_utc_ms INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (world_id, actor_id)
      );
      CREATE TABLE IF NOT EXISTS town_need_effects (
        world_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        effects_json TEXT NOT NULL,
        applied_at_utc_ms INTEGER NOT NULL,
        PRIMARY KEY (world_id, actor_id, source_key)
      );
      CREATE TABLE IF NOT EXISTS town_mood_influences (
        world_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        intensity REAL NOT NULL CHECK (intensity >= -1 AND intensity <= 1),
        created_at_utc_ms INTEGER NOT NULL,
        expires_at_utc_ms INTEGER NOT NULL,
        PRIMARY KEY (world_id, actor_id, source_key)
      );
      -- M3 有向关系：A 对 B 与 B 对 A 分开保存；合并/退役身份不写新行（历史行保留）
      CREATE TABLE IF NOT EXISTS town_actor_relationships (
        world_id TEXT NOT NULL,
        from_actor_id TEXT NOT NULL,
        to_actor_id TEXT NOT NULL,
        familiarity REAL NOT NULL DEFAULT 0 CHECK (familiarity >= 0 AND familiarity <= 100),
        affection REAL NOT NULL DEFAULT 0 CHECK (affection >= -100 AND affection <= 100),
        trust REAL NOT NULL DEFAULT 0 CHECK (trust >= 0 AND trust <= 100),
        conflict REAL NOT NULL DEFAULT 0 CHECK (conflict >= 0 AND conflict <= 100),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at_utc_ms INTEGER,
        PRIMARY KEY (world_id, from_actor_id, to_actor_id)
      );
      -- 关系效果来源（幂等：同一来源同一方向只结算一次；按行计今日次数实现每日上限）
      CREATE TABLE IF NOT EXISTS town_relationship_effects (
        world_id TEXT NOT NULL,
        from_actor_id TEXT NOT NULL,
        to_actor_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        effects_json TEXT NOT NULL,
        applied_at_utc_ms INTEGER NOT NULL,
        PRIMARY KEY (world_id, from_actor_id, to_actor_id, source_key)
      );
      -- M5 目标：每居民 1 个主目标（slot 0）+ 2 个近期愿望（slot 1/2）；进度从已结算事实消费
      CREATE TABLE IF NOT EXISTS town_resident_goals (
        world_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','blocked','replaced')),
        progress REAL NOT NULL DEFAULT 0,
        created_utc_ms INTEGER NOT NULL,
        updated_utc_ms INTEGER,
        PRIMARY KEY (world_id, actor_id, slot)
      );
      -- 目标挑选游标（按本地日挑选，不逐 tick 重选）
      CREATE TABLE IF NOT EXISTS town_resident_goal_cursor (
        world_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        last_pick_day INTEGER NOT NULL,
        PRIMARY KEY (world_id, actor_id)
      );
      -- M5 技能与习惯：来自有效行为，每日收益有上限；kind=skill 影响效率，habit 只加倾向
      CREATE TABLE IF NOT EXISTS town_resident_skills (
        world_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        key TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill','habit')),
        level REAL NOT NULL DEFAULT 0 CHECK (level >= 0 AND level <= 100),
        daily_gain REAL NOT NULL DEFAULT 0,
        daily_day INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (world_id, actor_id, key)
      );
      -- M6 导演候选：只能从真实条件建立（repeat_key 幂等）；展示不代表结算，
      -- 玩家不参与时按规则自行处理（handled）或过期（expired），不产生惩罚
      CREATE TABLE IF NOT EXISTS town_director_candidates (
        world_id TEXT NOT NULL,
        repeat_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        map_id INTEGER,
        payload_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','invited','handled','expired')),
        created_utc_ms INTEGER NOT NULL,
        expires_at_utc_ms INTEGER NOT NULL,
        updated_utc_ms INTEGER,
        PRIMARY KEY (world_id, repeat_key)
      );
    `);
    const registry = createTownActorRegistry(db);
    registry.synchronize();
    db.prepare('UPDATE town_world_state SET schema_version = ? WHERE singleton = 1').run(TOWN_SCHEMA_VERSION);
    return registry.getWorldState();
  })();
}
