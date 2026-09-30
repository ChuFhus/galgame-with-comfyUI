/**
 * 相遇的规则结算（M0：事实与表达分离）。
 *
 * 相遇收尾时由本地规则产生结构化结果（互动类型、结果代码、规则版本）与模板摘要，
 * 作为唯一权威事实落库；LLM 润色只是附加表现（polished_summary），不得改写已结算事实。
 * 本模块是纯函数：无 LLM、无 IO，随机仅来自确定性哈希域（相同快照与输入可复现）。
 */
import { createHash } from 'node:crypto';

export const TOWN_ENCOUNTER_RULE_VERSION = 1;

/** M0 仅有的互动类型；后续阶段（共同活动/帮助/争执等）在此扩展。 */
const INTERACTION_TYPES = new Set(['chat', 'pass_by']);

/** 结果代码域：silent_pass=照面没说话，brief_chat/chat=有对话，interrupted=收尾时被中断。 */
const RESULT_CODES = new Set(['silent_pass', 'brief_chat', 'chat', 'interrupted']);

/** 结果代码 → 经历摘要短语（townExperienceService 组装经历文本用，主语为「A和B在X」。） */
export const ENCOUNTER_OUTCOME_PHRASES = Object.freeze({
  silent_pass: '碰了个面，打了个照面',
  brief_chat: '简短地聊了几句',
  chat: '聊了一会儿天',
  interrupted: '的谈话被打断了',
});

/** 结果代码 → 模板摘要（town_encounters.summary 与发帖素材；同一短语域，口径集中在此）。 */
const SUMMARY_TEMPLATES = Object.freeze({
  silent_pass: '{a}和{b}在{loc}碰了个面，简单打了个照面。',
  brief_chat: '{a}和{b}在{loc}简短地聊了几句。',
  chat: '{a}和{b}在{loc}聊了一会儿天。',
  interrupted: '{a}和{b}在{loc}的谈话被打断了。',
});

/**
 * 确定性随机域：相同 (seed, mapId, pair, bucket) 恒返回同一 [0,1) 值。
 * 相遇判定用它替代 Math.random()，使「相同测试快照与输入」可复现；
 * 新增其他演出随机不得复用同一域（独立随机域互不影响）。
 */
export function encounterScanRandom({ seed, mapId, pair, bucket }) {
  const hash = createHash('sha256')
    .update(JSON.stringify(['town.encounter.scan', seed ?? null, mapId ?? null, String(pair), bucket]))
    .digest();
  return Number(hash.readBigUInt64BE(0) >> 11n) / 2 ** 53;
}

/**
 * 结算一次相遇的结构化结果。
 * @param {object} input
 * @param {number} input.messageCount   相遇期间落库的对话条数（无对话=0）
 * @param {number} input.durationMs     相遇持续时长
 * @param {string} [input.resultCode]   恢复路径直接指定（如 interrupted）；缺省按消息数/时长推导
 * @param {number} input.nowUtcMs       结算时刻（注入时钟，禁止内部读 Date.now）
 * @returns {frozen {interactionType, resultCode, ruleVersion, settledAtUtcMs}}
 */
export function settleEncounterOutcome({ messageCount = 0, durationMs = 0, resultCode = null, nowUtcMs }) {
  if (!Number.isSafeInteger(nowUtcMs)) throw new TypeError('nowUtcMs must be safe integer ms');
  if (!Number.isSafeInteger(messageCount) || messageCount < 0) throw new TypeError('messageCount must be >= 0');
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new TypeError('durationMs must be >= 0');
  let code = resultCode;
  if (code === null) {
    if (messageCount === 0) code = 'silent_pass';
    else if (messageCount < 3 || durationMs < 120_000) code = 'brief_chat';
    else code = 'chat';
  }
  if (!RESULT_CODES.has(code)) throw new TypeError(`unknown encounter resultCode: ${code}`);
  const interactionType = code === 'silent_pass' ? 'pass_by' : 'chat';
  return Object.freeze({
    interactionType,
    resultCode: code,
    ruleVersion: TOWN_ENCOUNTER_RULE_VERSION,
    settledAtUtcMs: nowUtcMs,
  });
}

/** 解析 outcome_json；坏数据按 null 处理（旧行/损坏行不做结构化校验，走兼容路径）。 */
export function parseEncounterOutcome(json) {
  if (typeof json !== 'string' || !json) return null;
  try {
    const value = JSON.parse(json);
    if (!value || !INTERACTION_TYPES.has(value.interactionType) || !RESULT_CODES.has(value.resultCode)
      || !Number.isSafeInteger(value.ruleVersion) || value.ruleVersion < 1) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 性格 → 相遇倾向修正（M1）：外向者更愿意碰面，内向者更少；单人因子 0.5×~1.5×，
 * 双方取几何平均（对称、可乘）。性格只改权重，不取消相遇本身（不会绝对无法相遇）。
 */
export function pairEncounterFactor(personalityA, personalityB) {
  const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
  const fa = 0.5 + clamp01(personalityA?.extraversion);
  const fb = 0.5 + clamp01(personalityB?.extraversion);
  return Math.sqrt(fa * fb);
}

/** 模板摘要：参与人与地点由调用方提供（镇内展示名），短语只由结果代码决定。 */
export function templateEncounterSummary({ outcome, nameA, nameB, locationName }) {
  const template = SUMMARY_TEMPLATES[outcome?.resultCode];
  if (!template) throw new TypeError(`unknown encounter resultCode: ${outcome?.resultCode}`);
  return template
    .replaceAll('{a}', String(nameA || '居民'))
    .replaceAll('{b}', String(nameB || '居民'))
    .replaceAll('{loc}', String(locationName || '小镇'));
}
