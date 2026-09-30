/**
 * M7：关键节点叙事适配器（town-update.md §6.8）。
 *
 * 模型返回的文字**永远不进入数值结算**：本适配器只做表现层——把服务端已确认的
 * 事实（来源事件、允许发言的人物、允许的选项）交给模型润色，输出必须通过严格
 * JSON 契约校验（来源一致、身份合法、选项一一对应、长度受界、无额外字段），
 * 否则回退本地模板。重复打开命中缓存不重新生成；自动叙事受每日预算约束，
 * 手动触发独立排队不计预算；失败有限重试后模板回退。
 *
 * 提示词骨架与字段约束逐字来自 §6.8「结构化输出示例约定」，新增字段必须同步
 * 修改示例、解析、校验和真实行为测试。
 */
import { createHash } from 'node:crypto';

const NARRATIVE_TEMPLATE_VERSION = 1;

/** 严格对象校验：键集合必须完全一致（拒绝额外/缺失字段）。 */
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = [...keys].sort().join(',');
  const actual = Object.keys(value).sort().join(',');
  return expected === actual;
}

const isText = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;

/**
 * @param {object} input
 * @param {object} input.narrativeConfig config.town.narrative
 */
export function createTownNarrativeService({ narrativeConfig }) {
  if (!narrativeConfig) throw new TypeError('townNarrativeService missing dependency');
  const cache = new Map();       // cacheKey → { narrative }
  const budget = new Map();      // worldId → { day, used }

  function cacheKey({ sourceEventId, factsVersion, allowedSpeakers, choices }) {
    const digest = createHash('sha256').update(JSON.stringify([
      'town.narrative', sourceEventId, factsVersion,
      allowedSpeakers.map(s => s.actorId), choices.map(c => c.choiceId), NARRATIVE_TEMPLATE_VERSION,
    ])).digest();
    return digest.toString('hex').slice(0, 32);
  }

  function underBudget(worldId, nowUtcMs) {
    const day = Math.floor(nowUtcMs / 86400000);
    let entry = budget.get(worldId);
    if (!entry || entry.day !== day) { entry = { day, used: 0 }; budget.set(worldId, entry); }
    return entry.used < narrativeConfig.dailyAutoQuota;
  }
  function chargeBudget(worldId, nowUtcMs) {
    const day = Math.floor(nowUtcMs / 86400000);
    const entry = budget.get(worldId);
    if (entry && entry.day === day) entry.used += 1;
  }

  /** 构建提示词：骨架逐字来自 §6.8；来源事件以调用方入参为权威（不抄 facts 文本）。 */
  function buildPrompt({ sourceEventId, facts, allowedSpeakers, choices }) {
    return [
      '你负责表现服务端已经确认的小镇情境。人物、事件、钱物和关系的事实以输入为准。',
      '不得新增已完成的交易、承诺、人物身份、道具或数值结果。',
      '严格按以下示例格式输出 JSON，不要输出解释、Markdown 代码围栏或 JSON 以外的文字。',
      '',
      '{',
      '  "sourceEventId": "（原样填写输入中的事件 ID，不得改写或生成新 ID）",',
      '  "summary": "（中文第三人称，20～80 字；只描述输入确认的事实，不预测未结算结果）",',
      '  "lines": [',
      '    {',
      '      "speakerActorId": "（只能使用输入允许发言的 actorId，不能填写人物名称代替 ID）",',
      '      "text": "（中文对白，10～80 字；符合该人物性格与知情范围，不承诺输入中不存在的奖励或结果）"',
      '    }',
      '  ],',
      '  "choices": [',
      '    {',
      '      "choiceId": "（原样填写输入提供的合法选项 ID，不得新增或改变映射）",',
      '      "label": "（中文选项文案，2～18 字；准确表达该选项意图，不夸大奖励或省略关键代价）"',
      '    }',
      '  ]',
      '}',
      '',
      `lines 总计 1～6 条，每条均遵守上述字段约束。`,
      `choices 必须与输入允许展示的选项一一对应；没有选项时输出空数组。`,
      `不得增加字段。sourceEventId 必须与本次输入一致。`,
      '',
      `【事件 ID】${sourceEventId}`,
      `【已确认事实】${facts.text}`,
      `【允许发言】${JSON.stringify(allowedSpeakers.map(s => ({ actorId: s.actorId, displayName: s.displayName })))}`,
      `【允许选项】${JSON.stringify(choices.map(c => ({ choiceId: c.choiceId, intent: c.intent })))}`,
    ].join('\n');
  }

  /** 契约校验：任何违规返回 null（调用方模板回退）。 */
  function validateModelOutput(parsed, { sourceEventId, allowedSpeakers, choices }) {
    if (!exactKeys(parsed, ['sourceEventId', 'summary', 'lines', 'choices'])) return null;
    if (parsed.sourceEventId !== sourceEventId) return null;
    if (!isText(parsed.summary, narrativeConfig.summaryMin, narrativeConfig.summaryMax)) return null;
    if (!Array.isArray(parsed.lines) || parsed.lines.length < 1
      || parsed.lines.length > narrativeConfig.linesMax) return null;
    const speakerIds = new Set(allowedSpeakers.map(s => s.actorId));
    for (const line of parsed.lines) {
      if (!exactKeys(line, ['speakerActorId', 'text'])) return null;
      if (!speakerIds.has(line.speakerActorId)) return null;
      if (!isText(line.text, narrativeConfig.lineMin, narrativeConfig.lineMax)) return null;
    }
    if (!Array.isArray(parsed.choices)) return null;
    const inputChoices = new Set(choices.map(c => c.choiceId));
    if (choices.length === 0 ? parsed.choices.length !== 0 : parsed.choices.length !== choices.length) return null;
    const seen = new Set();
    for (const choice of parsed.choices) {
      if (!exactKeys(choice, ['choiceId', 'label'])) return null;
      if (!inputChoices.has(choice.choiceId) || seen.has(choice.choiceId)) return null;
      seen.add(choice.choiceId);
      if (!isText(choice.label, narrativeConfig.labelMin, narrativeConfig.labelMax)) return null;
    }
    return parsed;
  }

  /** 本地模板回退：只用调用方给的事实文本，不编造任何新事实。 */
  function templateFallback({ sourceEventId, facts, allowedSpeakers, choices }) {
    const speaker = allowedSpeakers[0] ?? null;
    return {
      source: 'template',
      narrative: Object.freeze({
        sourceEventId,
        summary: facts.fallbackSummary,
        lines: speaker ? [{ speakerActorId: speaker.actorId, displayName: speaker.displayName,
          text: facts.fallbackLine }] : [],
        choices: choices.map(c => ({ choiceId: c.choiceId, label: c.fallbackLabel ?? c.intent })),
      }),
    };
  }

  function storeCache(key, value) {
    cache.set(key, value);
    if (cache.size > narrativeConfig.cacheMax) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  /**
   * 叙事一个已确认的情境。
   * @param {object} input
   * @param {string} input.sourceEventId   已结算来源事件 ID（原样校验）
   * @param {number} input.factsVersion    事实快照版本（参与缓存键）
   * @param {object} input.facts           { text, fallbackSummary, fallbackLine }
   * @param {Array}  input.allowedSpeakers [{ actorId, displayName }]
   * @param {Array}  input.choices         [{ choiceId, intent, fallbackLabel? }]
   * @param {string} input.worldId
   * @param {number} input.nowUtcMs
   * @param {'auto'|'manual'} [input.mode] auto 计入每日预算；manual 不计（玩家主动）
   * @param {Function} [input.chatSync]   LLM 客户端；缺省 = 零模型，直接模板回退
   * @returns {Promise<{source:'model'|'template', narrative}>}
   */
  async function narrate(input) {
    const { sourceEventId, factsVersion, facts, allowedSpeakers, choices, worldId, nowUtcMs } = input;
    if (typeof sourceEventId !== 'string' || !sourceEventId || !Number.isSafeInteger(factsVersion)
      || !facts?.text || !Array.isArray(allowedSpeakers) || !Array.isArray(choices)
      || !Number.isSafeInteger(nowUtcMs)) throw new TypeError('narrate missing input');
    const key = cacheKey({ sourceEventId, factsVersion, allowedSpeakers, choices });
    const cached = cache.get(key);
    if (cached) return cached;

    const mode = input.mode === 'manual' ? 'manual' : 'auto';
    if (mode === 'auto' && !underBudget(worldId, nowUtcMs)) {
      const fallback = templateFallback(input);
      storeCache(key, fallback);
      return fallback;
    }
    if (typeof input.chatSync !== 'function') {
      const fallback = templateFallback(input);
      storeCache(key, fallback);
      return fallback;
    }
    // 有限重试后模板回退；失败不阻塞世界运行
    for (let attempt = 0; attempt < narrativeConfig.maxAttempts; attempt++) {
      try {
        const content = await input.chatSync([
          { role: 'system', content: buildPrompt({ sourceEventId, facts, allowedSpeakers, choices }) },
        ], { max_tokens: 700, temperature: 0.8, label: '小镇关键叙事' });
        const parsed = JSON.parse(String(content ?? '').trim());
        const valid = validateModelOutput(parsed, { sourceEventId, allowedSpeakers, choices });
        if (valid) {
          const speakersById = new Map(allowedSpeakers.map(s => [s.actorId, s.displayName]));
          const result = { source: 'model', narrative: Object.freeze({
            sourceEventId,
            summary: valid.summary.trim(),
            lines: valid.lines.map(l => ({ speakerActorId: l.speakerActorId,
              displayName: speakersById.get(l.speakerActorId) ?? l.speakerActorId, text: l.text.trim() })),
            choices: valid.choices.map(c => ({ choiceId: c.choiceId, label: c.label.trim() })),
          }) };
          if (mode === 'auto') chargeBudget(worldId, nowUtcMs);
          storeCache(key, result);
          return result;
        }
      } catch { /* 校验失败或调用失败：有限重试后模板回退 */ }
    }
    const fallback = templateFallback(input);
    storeCache(key, fallback);
    return fallback;
  }

  return { narrate, buildPrompt, validateModelOutput, templateFallback };
}

export { NARRATIVE_TEMPLATE_VERSION };
