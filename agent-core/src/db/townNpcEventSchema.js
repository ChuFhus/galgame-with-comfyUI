/** 镇民 NPC 奇遇事件表——结构与 character_events / event_history 对齐，但主角是镇民（无角色卡）。
 * Requires the town schema (town_npcs) first. */
export function migrateTownNpcEventSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS town_npc_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      npc_id INTEGER NOT NULL REFERENCES town_npcs(id) ON DELETE CASCADE,
      event_type_key TEXT NOT NULL DEFAULT 'town.custom',
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','engaged','completed','expired','cancelled')),
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image TEXT,
      prompt TEXT,
      style TEXT,
      resolution TEXT DEFAULT '1600x1200',
      choice_a TEXT NOT NULL DEFAULT '',
      choice_b TEXT NOT NULL DEFAULT '',
      choice_c_label TEXT NOT NULL DEFAULT '自由行动',
      current_branch INTEGER DEFAULT 0,
      choice_history TEXT DEFAULT '[]',
      summary TEXT DEFAULT '',
      engaged INTEGER DEFAULT 0,
      processing INTEGER DEFAULT 0,
      world_id TEXT,
      world_epoch INTEGER,
      location_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      last_interaction_at DATETIME,
      error_message TEXT,
      narrative_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_town_npc_event_status ON town_npc_events(npc_id, status);
    -- 与 character_events 相同的并发口径：每位镇民同时最多一个活跃奇遇
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_town_npc_event
      ON town_npc_events(npc_id) WHERE status IN ('open','engaged');

    CREATE TABLE IF NOT EXISTS town_npc_event_history (
      id INTEGER PRIMARY KEY,
      npc_id INTEGER NOT NULL REFERENCES town_npcs(id) ON DELETE CASCADE,
      event_type_key TEXT,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      final_image TEXT,
      summary TEXT DEFAULT '',
      conclusion TEXT,
      choice_history TEXT DEFAULT '[]',
      total_branches INTEGER DEFAULT 0,
      engaged INTEGER DEFAULT 0,
      outcome TEXT,
      world_id TEXT,
      world_epoch INTEGER,
      location_key TEXT,
      created_at DATETIME,
      ended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      narrative_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_town_npc_event_history_npc ON town_npc_event_history(npc_id, ended_at);
  `);

  // M7 叙事增强（2026-10-01 接线）：ambient 奇遇创建时的角色对白，纯表现层（townNarrativeService）。
  // 老库幂等补列；历史表同列，归档时随行携带，历史卡片也能看到当时的对白。
  for (const table of ['town_npc_events', 'town_npc_event_history']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.length && !cols.find(c => c.name === 'narrative_json')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN narrative_json TEXT`);
    }
  }
}
