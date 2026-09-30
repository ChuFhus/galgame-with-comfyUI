#!/usr/bin/env node
/**
 * 小镇历史抖动数据清理（正式维护脚本，默认只报告不删除）。
 *
 * 背景：旧版「游走写进 FSM」会把同一目标反复启动→取消（SCHEDULE_CHANGED），
 * 每个居民每天可产生数万条 move_to 取消及其日志/事件，是存档体积的主要来源
 * （实测某镇 66 万条取消动作 / 56 万条日志与事件，占全部动作的 92%）。
 * 这些行没有玩法含义：终态 cancelled 的 move_to 不参与结算，动态列表也已隐藏取消行。
 *
 * 清理顺序（子表先删，最后删动作本体）：
 *   town_activity_log → town_resource_claims → town_event_deliveries
 *   → town_domain_events（跳过被 town_experiences 引用的）→ town_action_requests → town_actions
 *
 * 性能要点：所有删除都用 **rowid 游标线性推进**（每批从上一批最大 rowid 之后继续）。
 * 直接 `... LIMIT n` 每批从表头重扫，百万行时是 O(n²)，会卡到看不出进度。
 *
 * 用法：
 *   node scripts/townChurnCleanup.mjs                        # dry-run，只报告规模
 *   node scripts/townChurnCleanup.mjs --apply                # 真删（建议先停后端）
 *   node scripts/townChurnCleanup.mjs --days=7 --apply       # 只删 7 天前的
 *
 * 删除只释放 SQLite 内部空闲页，磁盘空间要等 app.js 启动时的 VACUUM 归还（重启一次后端即可）。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? 'true'];
}));
const apply = args.get('apply') === 'true';
const days = Number(args.get('days') ?? 1);
const batchSize = Math.max(500, Math.min(8000, Number(args.get('batch') ?? 5000)));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.resolve(root, args.get('db') ?? 'data/agent.db');
// 毫秒时间戳：town_actions.updated_at 是 INTEGER 毫秒，不能用字符串比较（INTEGER < TEXT 恒真）
const cutoff = Date.now() - days * 86400_000;

console.log(`[cleanup] db=${dbPath}`);
console.log(`[cleanup] 模式=${apply ? '应用删除' : 'dry-run'} | 保留 ${days} 天（cutoff=${new Date(cutoff).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}） | 批=${batchSize}`);

const db = new Database(dbPath);
db.pragma('busy_timeout = 15000');
const count = sql => db.prepare(sql).get().n;

// 抖动集合：旧版游走/等待都被写成 FSM 动作并反复取消。默认覆盖 move_to 与 wait，
// 可用 --types=move_to 收窄。
const types = String(args.get('types') ?? 'move_to,wait').split(',').map(t => t.trim()).filter(Boolean);
if (types.length === 0 || types.some(t => !/^[a-z_]+$/.test(t))) throw new Error(`--types 非法: ${types}`);
const TYPE_LIST = types.map(t => `'${t}'`).join(',');
console.log(`[cleanup] 抖动动作类型: ${types.join(', ')}`);
const CHURN_COND = `a.type IN (${TYPE_LIST}) AND a.status='cancelled' AND a.updated_at < ${cutoff}`;
const CHURN = `SELECT id FROM town_actions WHERE type IN (${TYPE_LIST}) AND status='cancelled' AND updated_at < ${cutoff}`;
const report = {
  取消态抖动动作: count(`SELECT count(*) n FROM (${CHURN})`),
  动作总数: count('SELECT count(*) n FROM town_actions'),
  活动日志_命中: count(`SELECT count(*) n FROM town_activity_log WHERE action_id IN (${CHURN})`),
  活动日志_总数: count('SELECT count(*) n FROM town_activity_log'),
  领域事件_命中: count(`SELECT count(*) n FROM town_domain_events e WHERE substr(e.event_id, 8, 36) IN (${CHURN})
    AND NOT EXISTS (SELECT 1 FROM town_experiences x WHERE x.event_id = e.event_id)`),
  领域事件_总数: count('SELECT count(*) n FROM town_domain_events'),
  孤儿事件_命中: count(`SELECT count(*) n FROM town_domain_events e WHERE e.type='town.action.changed'
    AND NOT EXISTS (SELECT 1 FROM town_actions a WHERE a.id = substr(e.event_id, 8, 36))
    AND NOT EXISTS (SELECT 1 FROM town_experiences x WHERE x.event_id = e.event_id)`),
  资源占用_命中: count(`SELECT count(*) n FROM town_resource_claims WHERE action_id IN (${CHURN})`),
  事件投递_命中: count(`SELECT count(*) n FROM town_event_deliveries WHERE event_id IN (
    SELECT e.event_id FROM town_domain_events e WHERE substr(e.event_id, 8, 36) IN (${CHURN}))`),
  动作请求_命中: count(`SELECT count(*) n FROM town_action_requests WHERE substr(request_key, 5, 36) IN (${CHURN})`),
};
for (const [label, value] of Object.entries(report)) console.log(`[cleanup] ${label}: ${value}`);
if (!apply) {
  console.log('[cleanup] dry-run 结束；加 --apply 执行删除（建议先停后端，减少锁争用）');
  db.close();
  process.exit(0);
}

/** rowid 游标线性推进：按 rowid > cursor 取一批 id，删掉后从该批最大 rowid 继续。 */
function sweep(label, selectSql, deleteSql) {
  let cursor = 0, deleted = 0;
  for (;;) {
    const ids = db.prepare(selectSql).all(cursor, batchSize).map(row => row.rid);
    if (ids.length === 0) break;
    cursor = ids[ids.length - 1];
    const placeholders = ids.map(() => '?').join(',');
    deleted += db.prepare(`${deleteSql} WHERE rowid IN (${placeholders})`).run(...ids).changes;
  }
  console.log(`[cleanup] ${label}: 删除 ${deleted}`);
  return deleted;
}

let total = 0;
total += sweep('town_activity_log',
  `SELECT l.rowid AS rid FROM town_activity_log l JOIN town_actions a ON a.id = l.action_id
   WHERE ${CHURN_COND} AND l.rowid > ? ORDER BY l.rowid LIMIT ?`,
  'DELETE FROM town_activity_log');
total += sweep('town_resource_claims',
  `SELECT c.rowid AS rid FROM town_resource_claims c JOIN town_actions a ON a.id = c.action_id
   WHERE ${CHURN_COND} AND c.rowid > ? ORDER BY c.rowid LIMIT ?`,
  'DELETE FROM town_resource_claims');
total += sweep('town_event_deliveries',
  `SELECT d.rowid AS rid FROM town_event_deliveries d JOIN town_domain_events e ON e.event_id = d.event_id
   JOIN town_actions a ON a.id = substr(e.event_id, 8, 36)
   WHERE ${CHURN_COND} AND d.rowid > ? ORDER BY d.rowid LIMIT ?`,
  'DELETE FROM town_event_deliveries');
// 事件表用「子查询 + substr」口径（与 dry-run 报告一致；JOIN 形式的关联表达式在 SQLite 里
// 不会走索引，且实测该写法在这里匹配不到行），并额外清理父动作已不存在的孤儿事件。
total += sweep('town_domain_events(抖动父事件)',
  `SELECT e.rowid AS rid FROM town_domain_events e
   WHERE substr(e.event_id, 8, 36) IN (${CHURN}) AND e.rowid > ?
     AND NOT EXISTS (SELECT 1 FROM town_experiences x WHERE x.event_id = e.event_id)
   ORDER BY e.rowid LIMIT ?`,
  'DELETE FROM town_domain_events');
total += sweep('town_domain_events(孤儿事件)',
  `SELECT e.rowid AS rid FROM town_domain_events e
   WHERE e.type = 'town.action.changed'
     AND NOT EXISTS (SELECT 1 FROM town_actions a WHERE a.id = substr(e.event_id, 8, 36))
     AND e.rowid > ?
     AND NOT EXISTS (SELECT 1 FROM town_experiences x WHERE x.event_id = e.event_id)
   ORDER BY e.rowid LIMIT ?`,
  'DELETE FROM town_domain_events');
total += sweep('town_action_requests',
  `SELECT r.rowid AS rid FROM town_action_requests r JOIN town_actions a ON a.id = substr(r.request_key, 5, 36)
   WHERE ${CHURN_COND} AND r.rowid > ? ORDER BY r.rowid LIMIT ?`,
  'DELETE FROM town_action_requests');
total += sweep('town_actions',
  `SELECT rowid AS rid FROM town_actions
   WHERE type IN (${TYPE_LIST}) AND status='cancelled' AND updated_at < ${cutoff} AND rowid > ? ORDER BY rowid LIMIT ?`,
  'DELETE FROM town_actions');

// ── 旧审计存量（2026-09-30 精简后已无读者）：活动流水表、action 类领域事件、幂等台账 ──
if (args.get('legacy') === 'true') {
  const legacy = {
    活动流水_全表: count('SELECT count(*) n FROM town_activity_log'),
    action类事件_无经历引用: count(`SELECT count(*) n FROM town_domain_events e WHERE e.type='town.action.changed'
      AND NOT EXISTS (SELECT 1 FROM town_experiences x WHERE x.event_id = e.event_id)`),
    幂等台账_全表: count('SELECT count(*) n FROM town_action_requests'),
  };
  for (const [label, value] of Object.entries(legacy)) console.log(`[cleanup] 旧存量 ${label}: ${value}`);
  if (apply) {
    let removed = 0;
    // 先删子行（投递）再删事件，最后删流水与台账
    removed += db.prepare(`DELETE FROM town_event_deliveries WHERE event_id IN (
      SELECT e.event_id FROM town_domain_events e WHERE e.type='town.action.changed'
      AND NOT EXISTS (SELECT 1 FROM town_experiences x WHERE x.event_id = e.event_id))`).run().changes;
    removed += db.prepare(`DELETE FROM town_domain_events WHERE type='town.action.changed'
      AND NOT EXISTS (SELECT 1 FROM town_experiences x WHERE x.event_id = event_id)`).run().changes;
    removed += db.prepare('DELETE FROM town_activity_log').run().changes;
    removed += db.prepare('DELETE FROM town_action_requests').run().changes;
    console.log(`[cleanup] 旧存量已删除 ${removed} 行`);
  }
}


console.log(`[cleanup] 完成，共删除 ${total} 行`);
console.log('[cleanup] 磁盘空间在下次后端启动的 VACUUM 归还（app.js 启动时按空闲页比例执行）');
db.close();
