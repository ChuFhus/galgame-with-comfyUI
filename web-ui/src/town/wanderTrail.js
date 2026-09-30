/**
 * 前端足迹（T11 补充）：只在浏览器内存里合成居民「移动到某地」的闲逛记录。
 *
 * 为什么在前端：随机游走已改成纯显示、不写 town_actions（旧写法会把同一目标反复
 * 启动/取消，是存档膨胀与抖动的主因）。游走又确实是居民最频繁的可见行为，所以这里
 * 只根据快照里「已到站的地点」变化，本地合成一条记录——**不落库、不给后端留痕**，
 * 刷新页面即消失。
 *
 * 纯函数、无副作用，便于单测。
 */

/** 每位居民最多保留的足迹条数（防止长开页面内存无限增长） */
export const WANDER_TRAIL_CAP = 40;

/**
 * 折进一帧快照，返回新的足迹表（不可变更新，未变化时原样返回）。
 * @param {object} trails   { [actorId]: [{ at, text, locationKey }] }（旧表）
 * @param {Array}  agents   快照里的居民数组（town.agents）
 * @param {number} nowMs    本地时间戳（记录时刻）
 * @returns {{ trails: object, changed: boolean }}
 */
export function foldWanderTrail(trails, agents, nowMs) {
  if (!Array.isArray(agents) || !Number.isFinite(nowMs)) return { trails, changed: false };
  const next = { ...trails };
  let changed = false;
  for (const agent of agents) {
    // 只认「已到站」的居民：走路中的 locationId 是目的地，提前记会写成"到达未发生"
    if (!agent?.actorId || agent.agentKey === 'me' || agent.kind === 'player') continue;
    if (agent.path && agent.path.length > 0) continue;
    const locationKey = agent.locationId != null ? `${agent.locationId}` : null;
    const locationName = agent.locationName || null;
    if (!locationKey || !locationName) continue;

    const previous = next[agent.actorId];
    const lastKey = previous && previous.length ? previous[previous.length - 1].locationKey : null;
    if (lastKey === locationKey) continue;

    const entry = { at: nowMs, text: `在${locationName}闲逛`, locationKey, local: true };
    next[agent.actorId] = [...(previous || []), entry].slice(-WANDER_TRAIL_CAP);
    changed = true;
  }
  return { trails: next, changed };
}

/**
 * 把后端行动记录与本地足迹合并成一条按时间倒序的列表（供对话框「动态」页签展示）。
 * 本地条目标了 local=true，UI 用「足迹」小标签区分，并注明不落库。
 */
export function mergeActivityWithTrail(entries, trail) {
  const merged = [
    ...(Array.isArray(entries) ? entries : []),
    ...(Array.isArray(trail) ? trail.map((entry, index) => ({
      seq: `local:${entry.locationKey}:${entry.at}:${index}`,
      text: entry.text, occurredAt: entry.at, local: true,
    })) : []),
  ];
  return merged.sort((a, b) => b.occurredAt - a.occurredAt);
}
