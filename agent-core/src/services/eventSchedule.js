/** 奇遇占用开场日程；只修改每日快照，不修改日程模板。 */
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { getLocalDateKey } from '../utils/localDate.js';

function toMinutes(value) {
  if (!/^\d{1,2}:\d{2}$/.test(String(value || ''))) return null;
  const [h, m] = value.split(':').map(Number);
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}

function toTime(minutes) {
  return `${String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseDate(value) {
  if (!value) return new Date(NaN);
  return new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
}

function loadSchedule(db, characterId, date) {
  const row = db.prepare('SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?')
    .get(characterId, date)
    || db.prepare('SELECT schedule_json FROM schedule_templates WHERE character_id = ?').get(characterId);
  try {
    const schedule = JSON.parse(row?.schedule_json || 'null');
    return Array.isArray(schedule) ? schedule : null;
  } catch { return null; }
}

/** 保留完整活动信息及真实起止日期，跨分支、跨午夜仍使用同一个日程起点。 */
export function captureEventSchedule(characterId, now = new Date(), db = getDb()) {
  if (config.features.schedule === false) return null;
  const character = db.prepare('SELECT schedule_enabled FROM characters WHERE id = ?').get(characterId);
  if (!character || character.schedule_enabled === 0) return null;
  const schedule = loadSchedule(db, characterId, getLocalDateKey(now));
  if (!schedule) return null;
  const minute = now.getHours() * 60 + now.getMinutes();
  for (const activity of schedule) {
    const start = toMinutes(activity.startTime);
    const end = toMinutes(activity.endTime);
    if (start === null || end === null || start === end) continue;
    const crossesMidnight = end < start;
    if (!(crossesMidnight ? minute >= start || minute < end : minute >= start && minute < end)) continue;
    const startAt = new Date(now);
    startAt.setHours(0, start, 0, 0);
    if (crossesMidnight && minute < end) startAt.setDate(startAt.getDate() - 1);
    const endAt = new Date(startAt);
    endAt.setHours(0, end, 0, 0);
    if (crossesMidnight) endAt.setDate(endAt.getDate() + 1);
    return { activity: { ...activity }, startAt: startAt.toISOString(), endAt: endAt.toISOString() };
  }
  return null;
}

/** 用开场活动覆盖给定的日内区间，完全覆盖的条目删除，部分覆盖的保留剩余时间。 */
export function reserveEventTime(schedule, activity, start, end) {
  // 后续分支保留运行中更新的状态（例如特殊朋友圈已经发送），避免恢复开场时的旧标记。
  const existing = schedule.find(item => item.startTime === toTime(start)
    && item.activity === activity.activity && item.location === activity.location);
  const reserved = existing ? { ...activity, ...existing } : activity;
  const kept = [];
  for (const item of schedule) {
    const s = toMinutes(item.startTime);
    const e = toMinutes(item.endTime);
    if (s === null || e === null || s === e) { kept.push(item); continue; }
    const segments = e < s ? [[0, e], [s, 1440]] : [[s, e]];
    if (!segments.some(([a, b]) => a < end && start < b)) { kept.push(item); continue; }
    for (const [a, b] of segments) {
      if (a >= b) continue;
      if (a >= end || b <= start) {
        kept.push({ ...item, startTime: toTime(a), endTime: toTime(b) });
      } else {
        if (a < start) kept.push({ ...item, startTime: toTime(a), endTime: toTime(start) });
        if (b > end) kept.push({ ...item, startTime: toTime(end), endTime: toTime(b) });
      }
    }
  }
  // 午夜沿用日程系统的 00:00；整日占用拆成两段，避免 00:00-00:00 被当作零长度。
  if (start === 0 && end === 1440) {
    kept.push({ ...reserved, startTime: '00:00', endTime: '12:00' },
      { ...reserved, startTime: '12:00', endTime: '00:00' });
  } else {
    kept.push({ ...reserved, startTime: toTime(start), endTime: toTime(end) });
  }
  return kept.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
}

/**
 * 依据奇遇到期时间延长开场日程。返回变更的日期，调用方在提交后清缓存、同步状态。
 * 老奇遇从 created_at 对应的日程恢复绑定；明确存储的 null 表示开场没有日程。
 */
export function extendEventSchedule(event, db = getDb()) {
  if (config.features.schedule === false) return [];
  const character = db.prepare('SELECT schedule_enabled FROM characters WHERE id = ?').get(event.character_id);
  if (!character || character.schedule_enabled === 0) return [];
  let history;
  try { history = JSON.parse(event.choice_history || '[]'); } catch { return []; }
  if (!Array.isArray(history)) return [];
  let binding = history[0]?.scheduleBinding;
  if (binding === undefined) {
    const createdAt = parseDate(event.created_at);
    if (!Number.isFinite(createdAt.getTime())) return [];
    binding = captureEventSchedule(event.character_id, createdAt, db);
    if (!history.length) history.push({ branch: 0, choice_label: '事件开始', summary: event.description, image: event.image });
    history[0].scheduleBinding = binding;
    event.choice_history = JSON.stringify(history);
    db.prepare('UPDATE character_events SET choice_history = ? WHERE id = ?').run(event.choice_history, event.id);
  }
  if (!binding) return [];
  const startAt = parseDate(binding.startAt);
  const originalEnd = parseDate(binding.endAt);
  const expiresAt = parseDate(event.expires_at);
  if (![startAt, originalEnd, expiresAt].every(date => Number.isFinite(date.getTime())) || expiresAt <= originalEnd) return [];

  // 日程精度为分钟，向上取整，确保最后几十秒也由奇遇占用。
  const endAt = new Date(Math.ceil(expiresAt.getTime() / 60000) * 60000);
  const changes = [];
  db.transaction(() => {
    const day = new Date(startAt);
    day.setHours(0, 0, 0, 0);
    while (day < endAt) {
      const nextDay = new Date(day);
      nextDay.setDate(nextDay.getDate() + 1);
      const date = getLocalDateKey(day);
      const schedule = loadSchedule(db, event.character_id, date);
      if (schedule) {
        const start = day < startAt ? startAt.getHours() * 60 + startAt.getMinutes() : 0;
        const end = nextDay <= endAt ? 1440 : endAt.getHours() * 60 + endAt.getMinutes();
        const updated = reserveEventTime(schedule, binding.activity, start, end);
        if (JSON.stringify(updated) !== JSON.stringify(schedule)) {
          db.prepare(`INSERT INTO daily_schedules (character_id, schedule_date, schedule_json)
            VALUES (?, ?, ?) ON CONFLICT(character_id, schedule_date)
            DO UPDATE SET schedule_json = excluded.schedule_json, generated_at = CURRENT_TIMESTAMP`)
            .run(event.character_id, date, JSON.stringify(updated));
          changes.push({ date, activity: updated.find(item => item.startTime === toTime(start)) });
        }
      }
      day.setDate(day.getDate() + 1);
    }
  })();
  return changes;
}

/** 每日快照重新派生时保留尚未结束的奇遇占用（包括跨午夜奇遇）。 */
export function reapplyActiveEventSchedule(characterId, db = getDb()) {
  const events = db.prepare("SELECT * FROM character_events WHERE character_id = ? AND status IN ('open', 'engaged')")
    .all(characterId);
  for (const event of events) {
    if (parseDate(event.expires_at) > new Date()) extendEventSchedule(event, db);
  }
}
