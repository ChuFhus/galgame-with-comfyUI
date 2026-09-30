/**
 * M2：空闲生活动作决策（town-update.md §6.3 决策顺序的规则层实现）。
 *
 * 纯函数、无 IO 无 LLM：根据需求快照、性格/兴趣、场所能力（含距离）给空闲居民
 * 选一个生活动作（eat/read/sit），或返回 null 交还给既有游走/等待逻辑。
 *
 * 评分口径（分段线性，0-100，可解释）：
 *   动作分数 = 需求紧迫度（低于阈值才产生，越低越高）
 *            + 性格与兴趣匹配
 *            − 路程成本（切比雪夫距离）
 *   最高分与次高分差在 nearBand 内时用确定性随机域挑选（同快照同分钟恒定，
 *   随机域 'town.life.decision' 与相遇扫描相互独立）。
 *
 * 滞回：调用方传入 current（正在执行/刚决定的生活动作），只要需求尚未恢复出
 * 滞回带就原样保留，避免相邻 tick 反复换目标（防 SCHEDULE_CHANGED 抖动）。
 */
import { createHash } from 'node:crypto';

export const LIFE_ACTIONS = Object.freeze(['eat', 'read', 'sit']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = v => clamp(Number.isFinite(v) ? v : 0, 0, 1);
const need = (needs, key) => clamp(Number.isFinite(needs?.[key]) ? needs[key] : 100, 0, 100);

/** 确定性随机域（独立命名空间，相同输入恒定，[0,1)）。 */
export function lifeDecisionRandom(parts) {
  const hash = createHash('sha256').update(JSON.stringify(['town.life.decision', ...parts])).digest();
  return Number(hash.readBigUInt64BE(0) >> 11n) / 2 ** 53;
}

const chebyshev = (a, b) => Math.max(Math.abs(a.x - (b?.x ?? 0)), Math.abs(a.y - (b?.y ?? 0)));

/** 最近的目标场所：按 (距离, key) 字典序，确定性。 */
function nearestVenue(venues, offer) {
  let best = null;
  for (const venue of venues) {
    if (!venue.offers?.includes(offer) || !venue.key) continue;
    if (!best || venue.distance < best.distance
      || (venue.distance === best.distance && venue.key < best.key)) best = venue;
  }
  return best;
}

/** 客满判定：该场所当前生活动作占用 ≥ 容量（M2 容量占用，赶路不计数见宿主口径）。 */
const isFull = (venue, offer, occupancy, capacity) =>
  (occupancy?.[venue.key] ?? 0) >= (capacity?.[offer] ?? Infinity);

/**
 * 空闲生活决策。
 * @param {object} input
 * @param {object}   input.needs      六类满足度（0-100；缺失按 100 满足处理）
 * @param {object}   [input.personality] 性格（0-1，可缺省）
 * @param {string[]} [input.interests] 兴趣标签（如 ['料理','阅读']）
 * @param {Array}    input.venues     [{ key, offers, x, y }]（本图地点 + offers，由场所能力层提供）
 * @param {{x:number,y:number}} input.position 当前位置
 * @param {{action:string,target:string}|null} [input.current] 当前生活计划（滞回）
 * @param {object}   input.config     config.town.life（阈值/权重/滞回带）
 * @param {number}   input.nowUtcMs   逻辑时间（确定性选择用）
 * @param {string}   [input.worldSeed] 世界种子
 * @param {string}   input.actorId
 * @returns {{action:string,target:string,score:number,candidates:Array}|null}
 *          null = 交给既有游走/等待逻辑
 */
export function pickIdleLifeAction(input) {
  const { needs, venues, position, config: cfg, nowUtcMs, actorId } = input;
  if (!needs || !Array.isArray(venues) || !position || !cfg || !Number.isSafeInteger(nowUtcMs)
    || !actorId) throw new TypeError('pickIdleLifeAction missing input');
  const occupancy = input.occupancy ?? {};
  const capacity = cfg.capacity ?? {};

  // 滞回：当前计划的需求带尚未恢复出带顶且场所未客满 → 原样保留
  const current = input.current ?? null;
  if (current && LIFE_ACTIONS.includes(current.action) && current.target) {
    const keepBand = cfg.keepBand?.[current.action] ?? 0;
    const relevant = { eat: need(needs, 'satiety'), read: need(needs, 'fun'), sit: need(needs, 'energy') }[current.action];
    const venue = venues.find(v => v.key === current.target && v.offers?.includes(current.action));
    if (relevant < keepBand && venue && !isFull(venue, current.action, occupancy, capacity)) {
      return { action: current.action, target: current.target, score: null, candidates: [] };
    }
  }

  const satiety = need(needs, 'satiety');
  const energy = need(needs, 'energy');
  const fun = need(needs, 'fun');
  const comfort = need(needs, 'comfort');
  const curiosity = clamp01(input.personality?.curiosity);
  const friendliness = clamp01(input.personality?.friendliness);
  const interests = Array.isArray(input.interests) ? input.interests : [];

  const candidates = [];
  // 目标/习惯偏置（M5）：活跃兴趣目标与习惯等级给匹配动作加分（目标改变下一步行动评分）
  const bias = input.goalBias ?? {};
  // 吃饭：饱食低于阈值才产生紧迫度；料理兴趣小幅加成；客满场所被排除（改选他家/其他动作）
  const eatVenue = nearestVenue(venues.map(v => ({ ...v, distance: chebyshev(position, v) }))
    .filter(v => !isFull(v, 'eat', occupancy, capacity)), 'eat');
  if (eatVenue && satiety < cfg.urgency.eatBelow) {
    const score = clamp((cfg.urgency.eatBelow - satiety) * cfg.weight.eatPerNeedPoint
      + (interests.includes('料理') ? cfg.weight.interestBonus : 0)
      + (bias.eat ?? 0)
      - eatVenue.distance * cfg.weight.distanceCost, 0, 100);
    candidates.push({ action: 'eat', target: eatVenue.key, score });
  }
  // 阅读：娱乐驱动 + 好奇心/阅读兴趣加成
  const readVenue = nearestVenue(venues.map(v => ({ ...v, distance: chebyshev(position, v) }))
    .filter(v => !isFull(v, 'read', occupancy, capacity)), 'read');
  if (readVenue && fun < cfg.urgency.funBelow) {
    const score = clamp((cfg.urgency.funBelow - fun) * cfg.weight.readPerNeedPoint
      + curiosity * cfg.weight.curiosityBonus
      + (interests.includes('阅读') ? cfg.weight.interestBonus : 0)
      + (bias.read ?? 0)
      - readVenue.distance * cfg.weight.distanceCost, 0, 100);
    candidates.push({ action: 'read', target: readVenue.key, score });
  }
  // 落座休息：疲惫或不适驱动（非睡觉的轻恢复）
  const sitVenue = nearestVenue(venues.map(v => ({ ...v, distance: chebyshev(position, v) }))
    .filter(v => !isFull(v, 'sit', occupancy, capacity)), 'sit');
  if (sitVenue && (energy < cfg.urgency.energyBelow || comfort < cfg.urgency.comfortBelow)) {
    const score = clamp(Math.max((cfg.urgency.energyBelow - energy) * cfg.weight.sitPerEnergyPoint,
      (cfg.urgency.comfortBelow - comfort) * cfg.weight.sitPerComfortPoint)
      - sitVenue.distance * cfg.weight.distanceCost, 0, 100);
    candidates.push({ action: 'sit', target: sitVenue.key, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.action.localeCompare(b.action));
  const top = candidates[0];
  // 近分平局：确定性随机挑选，避免全体居民同一时刻做同一件事
  if (candidates.length > 1 && top.score - candidates[1].score <= cfg.nearBand) {
    const bucket = Math.floor(nowUtcMs / 60_000);
    const draw = lifeDecisionRandom([input.worldSeed ?? null, actorId, bucket]);
    const pool = candidates.filter(c => top.score - c.score <= cfg.nearBand);
    const picked = pool[Math.floor(draw * pool.length) % pool.length];
    return { ...picked, candidates };
  }
  return { ...top, candidates };
}
