/**
 * 居民活动流水（T11 §8.1）：**一行动作 = 一条动态**，直接读 `town_actions`。
 *
 * 精简口径（2026-09-30）：原先每次状态流转都写 town_activity_log + 领域事件，
 * 而续租命令每 5 秒还要写一条幂等台账——一个 15 分钟的动作能产生 200 行记录。
 * 现在动作行自带状态、理由（last_reason）、规则来源与产物，信息流不再另开流水表：
 *   - 一条动态 ≈ 一次动作（做完/失败/进行中），量级与居民真实活动一致
 *   - 「理由」来自 last_reason（SCHEDULE_CHANGED / DURATION_ELAPSED / PATH_UNREACHABLE…）
 *     与 rule_key（作息·上班 / 需求·吃饭 …），回答“为什么做这件事 / 为什么中断”
 *   - 取消态不展示（多为调度切换噪音，理由仍留在动作行可查）
 */
import { getDb } from '../../db/index.js';
import { createTownActorRegistry } from './townActorRegistry.js';
import { createActorDirectory } from './townActorDirectory.js';

const REASON_LABELS = Object.freeze({
  DURATION_ELAPSED: '做完了', ARRIVED: '到了', SCHEDULE_CHANGED: '作息变了',
  PATH_UNREACHABLE: '路走不通', LEFT_TARGET: '中途离开了', LEASE_EXPIRED: '被打断了',
  SCHEDULE_BLOCKED: '日程不让做', TARGET_OR_ACTOR_MISSING: '目标没了', ACTOR_UNAVAILABLE: '人不在镇上',
  MEMBERSHIP_CHANGED: '身份变了', SIMULATION_SCOPE_ENDED: '离开了这张图', RESOURCE_BUSY: '位置被占了',
  START: '开始了', VALIDATED: '刚创建',
});
const RULE_LABELS = Object.freeze({
  'town.routine.work': '作息·上班', 'town.routine.rest': '作息·休息', 'town.routine.wait': '作息·空闲',
  'town.life.eat': '需求·吃饭', 'town.life.eat.urgent': '需求·饿得急', 'town.life.read': '兴趣·阅读',
  'town.life.sit': '需求·歇脚',
});

const clampLimit = (value, fallback, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
};

/** 规则来源 → 人话理由（含避雨等后缀规则）。 */
export function ruleLabel(ruleKey) {
  if (!ruleKey) return null;
  if (RULE_LABELS[ruleKey]) return RULE_LABELS[ruleKey];
  if (ruleKey.startsWith('town.shelter')) return '天气·避雨';
  const tail = String(ruleKey).split('.').pop();
  return tail || null;
}

/** 一次动作 → 一条动态文案；返回 null 表示不展示（取消态等噪音）。 */
export function describeAction(row, locationName) {
  const where = locationName ? `在${locationName}` : '在镇上';
  const to = locationName || '目的地';
  const status = row.status;
  if (status === 'cancelled') return null;
  switch (row.type) {
    case 'move_to':
      if (status === 'completed') return `到了${to}`;
      if (status === 'failed') return row.failure_reason === 'PATH_UNREACHABLE' ? `想去${to}，但路走不通` : `去${to}的路上出了岔子`;
      return `在去${to}的路上`;
    case 'work_shift':
      if (status === 'completed') return `结束了${locationName ? `在${locationName}` : ''}的工作`;
      if (status === 'failed') return `${where}的班次中断了`;
      return `${where}上工`;
    case 'rest':
      if (status === 'completed') return `${where}休息好了`;
      if (status === 'failed') return `${where}没休息成`;
      return `${where}休息`;
    case 'life_eat':
      if (status === 'completed') return `${where}吃了点东西`;
      if (status === 'failed') return `${where}没能吃上饭`;
      return `${where}找吃的`;
    case 'life_read':
      if (status === 'completed') return `${where}读了会儿书`;
      if (status === 'failed') return `${where}没看成书`;
      return `${where}看书`;
    case 'life_sit':
      if (status === 'failed') return null;
      return status === 'completed' ? `${where}坐了一会儿` : `${where}歇脚`;
    case 'wait':
      return status === 'running' ? `${where}闲逛` : null;
    default:
      return null;
  }
}

/** 行动作行的「理由」：失败先看失败原因，否则看规则来源／上次流转原因。 */
export function actionReason(row) {
  if (row.status === 'failed' && row.failure_reason) return REASON_LABELS[row.failure_reason] || row.failure_reason;
  const rule = ruleLabel(row.rule_key);
  if (rule) return rule;
  return REASON_LABELS[row.last_reason] || row.last_reason || null;
}

/**
 * @param {object} input
 * @param {object} input.db       better-sqlite3 连接
 * @param {object} input.registry townActorRegistry（用于名字/地图解析）
 */
export function createTownActivityFeed({ db, registry }) {
  if (!db?.prepare || !registry?.getActor) throw new TypeError('townActivityFeed missing dependency');


  const ACTIONS_SQL = `SELECT id, actor_id, type, status, target, rule_key, last_reason, failure_reason,
      started_at, due_at, updated_at FROM town_actions
    WHERE world_id = ? AND status != 'cancelled'`;

  function toEntries(rows, worldId) {
    const directory = createActorDirectory({ db, registry, worldId });
    const entries = [];
    const lastKept = new Map();
    for (const row of rows) {
      const actor = directory.actor(row.actor_id);
      const text = describeAction(row, directory.location(actor.mapId, row.target));
      if (!text) continue;
      const occurredAt = row.started_at ?? row.updated_at;
      // 同居民、同文案、1 小时内连续重复折叠：上班/休息会被切成 15 分钟一段，
      // 不加宽窗口的话「结束了…的工作」会每刻钟刷一条（那里只是同一段生活的续写）
      const previous = lastKept.get(row.actor_id);
      if (previous && previous.text === text && previous.occurredAt - occurredAt <= 60 * 60_000) continue;
      lastKept.set(row.actor_id, { text, occurredAt });
      entries.push({ seq: row.id, actorId: row.actor_id, name: actor.name, text,
        reason: actionReason(row), status: row.status, occurredAt });
    }
    return entries;
  }

  /** 全镇信息流（左上角浮窗 / 动态面板）。 */
  function recent({ limit = 40 } = {}) {
    const world = registry.getWorldState();
    const rows = db.prepare(`${ACTIONS_SQL} AND type != 'wait'
      ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ?`).all(world.worldId, clampLimit(limit, 40, 100));
    return toEntries(rows, world.worldId);
  }

  /** 单个居民的最近动态（对话框「动态」页签，默认 100 条）。 */
  function ofActor(actorId, { limit = 100 } = {}) {
    const world = registry.getWorldState();
    if (typeof actorId !== 'string' || !actorId) return [];
    const rows = db.prepare(`${ACTIONS_SQL} AND actor_id = ?
      ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ?`).all(world.worldId, actorId, clampLimit(limit, 100, 200));
    return toEntries(rows, world.worldId);
  }

  return { recent, ofActor };
}

/** 请求级入口（与 routes/town.js 其他读接口同款惰性构造）。 */
export function getTownActivityFeed() {
  const db = getDb();
  return createTownActivityFeed({ db, registry: createTownActorRegistry(db) });
}
