/** Explicit, repeatable migration. Does not open a database or own world/actor tables. */
export function migrateTownActionSchema(db) {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS town_actions (
      id TEXT PRIMARY KEY, world_id TEXT NOT NULL, world_epoch INTEGER NOT NULL,
      actor_id TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('validated','reserved','running','completed','cancelled','failed')),
      version INTEGER NOT NULL DEFAULT 1, target TEXT, payload TEXT NOT NULL,
      rule_key TEXT, rule_version INTEGER, started_at INTEGER, due_at INTEGER,
      updated_at INTEGER NOT NULL, failure_reason TEXT, result TEXT,
      -- 精简后：一行动作自带「上次状态变化的理由」（如 SCHEDULE_CHANGED / DURATION_ELAPSED /
      -- PATH_UNREACHABLE）。理由不再另开流水表，信息流直接读动作行。
      last_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS town_actions_actor_active
      ON town_actions(world_id, world_epoch, actor_id) WHERE status IN ('reserved','running');
    CREATE INDEX IF NOT EXISTS town_actions_due ON town_actions(status, due_at);
    CREATE INDEX IF NOT EXISTS town_actions_actor_rule_type
      ON town_actions(world_id, world_epoch, actor_id, rule_key, type);
    CREATE INDEX IF NOT EXISTS town_actions_actor_current ON town_actions(world_id, world_epoch, actor_id, updated_at DESC)
      WHERE status IN ('validated','reserved','running');
    -- 生活占用聚合的专用部分索引：谓词必须与 townService.lifeVenueOccupancy 的查询逐字一致
    -- （type 用 IN 列表而非 LIKE，查询计划器才能采用），否则在百万行意图日志上每次全前缀扫描
    CREATE INDEX IF NOT EXISTS town_actions_life_active
      ON town_actions(world_id, world_epoch, target)
      WHERE type IN ('life_eat','life_read','life_sit')
        AND status IN ('reserved','running') AND target IS NOT NULL;
    CREATE TABLE IF NOT EXISTS town_action_requests (
      world_id TEXT NOT NULL, world_epoch INTEGER NOT NULL, request_key TEXT NOT NULL,
      payload TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER,
      PRIMARY KEY(world_id, world_epoch, request_key)
    );
    CREATE TABLE IF NOT EXISTS town_resource_claims (
      world_id TEXT NOT NULL, world_epoch INTEGER NOT NULL, resource_key TEXT NOT NULL,
      action_id TEXT NOT NULL REFERENCES town_actions(id), lease_until INTEGER NOT NULL,
      PRIMARY KEY(world_id, world_epoch, resource_key)
    );
    CREATE INDEX IF NOT EXISTS town_claims_owner ON town_resource_claims(action_id);
    CREATE TABLE IF NOT EXISTS town_domain_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      world_id TEXT NOT NULL, world_epoch INTEGER NOT NULL, type TEXT NOT NULL,
      root_event_id TEXT NOT NULL, depth INTEGER NOT NULL, envelope TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS town_event_deliveries (
      event_id TEXT NOT NULL REFERENCES town_domain_events(event_id), consumer_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','done','dead')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
      lease_until INTEGER, lease_token TEXT, last_error TEXT,
      PRIMARY KEY(event_id, consumer_key)
    );
    CREATE INDEX IF NOT EXISTS town_delivery_due ON town_event_deliveries(status, next_attempt_at);
  `))();
  // town_activity_log 已彻底废弃：记录模型精简为「一行动作自带理由」（town_actions.last_reason），
  // 该表既无写入方也无读取方。DROP 而非保留——它是历史 churn 的最大来源（与 actions 同量级增长），
  // 留着会让升级用户白背几百万行，还给 town_actions 挂一条 FK 拖慢动作回收。
  // 子表删除不校验引用，foreign_keys=ON 下也安全。
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='town_activity_log'`).get()) {
    db.exec('DROP TABLE town_activity_log');
    console.log('[db] dropped legacy town_activity_log (action reasons now live on town_actions.last_reason)');
  }
  // 旧库补列：幂等记录需要时间戳才能按保留期清理（旧行 created_at 为 NULL，由 epoch 轮换代删；
  // 该表每 5s 子拍为在飞动作写一条 advance 记录，日增可达数十万行，是库里最大的无界增长源）
  // 旧库补列：last_reason（一行动作自带理由；旧库为空的行走兼容路径）
  const actionCols = db.prepare('PRAGMA table_info(town_actions)').all();
  if (actionCols.length && !actionCols.find(c => c.name === 'last_reason')) {
    db.exec('ALTER TABLE town_actions ADD COLUMN last_reason TEXT');
  }
  const reqCols = db.prepare('PRAGMA table_info(town_action_requests)').all();
  if (reqCols.length && !reqCols.find(c => c.name === 'created_at')) {
    db.exec('ALTER TABLE town_action_requests ADD COLUMN created_at INTEGER DEFAULT NULL');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS town_action_requests_created
    ON town_action_requests(created_at) WHERE created_at IS NOT NULL`);
}
