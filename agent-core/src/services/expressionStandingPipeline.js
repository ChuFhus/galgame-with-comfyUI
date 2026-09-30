export const STANDING_COMPOSITION = 'full body, head to toe, white background, simple background';
/** 固定构图标签（含单人 solo）由系统统一前置，提示词本身不要重复输出 */
export const STANDING_PREFIX = `solo, ${STANDING_COMPOSITION}`;

/**
 * 统一前置固定构图标签：立绘提示词进 ComfyUI 前一律以 solo 开头。
 *
 * 历史提示词里那份不带 solo 的旧标签（STANDING_COMPOSITION）会被改写成新口径，
 * 而不是再前置一遍，避免同一串标签在开头重复两次。
 */
export function frameStandingPrompt(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text) return STANDING_PREFIX;
  if (text.startsWith(STANDING_PREFIX)) return text;
  if (text.startsWith(STANDING_COMPOSITION)) {
    const rest = text.slice(STANDING_COMPOSITION.length).replace(/^[\s,]+/, '');
    return rest ? `${STANDING_PREFIX}, ${rest}` : STANDING_PREFIX;
  }
  return `${STANDING_PREFIX}, ${text}`;
}

export function parseStandingPrompts(raw, slots) {
  const parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!Array.isArray(parsed.prompts) || parsed.prompts.length !== slots.length) throw new Error('立绘提示词数量不完整，请重试');
  const expected = new Set(slots.map(s => s.id));
  const result = new Map();
  for (const item of parsed.prompts) {
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!expected.has(item.slotId) || result.has(item.slotId) || prompt.length < 10 || prompt.length > 800 || /[\u3400-\u9fff]/u.test(prompt)) throw new Error('立绘提示词格式或内容不完整，请重试');
    result.set(item.slotId, frameStandingPrompt(prompt));
  }
  return result;
}

/** The all-prompts barrier is deliberate: no render may run before savePrompts succeeds. */
export async function runStandingBatch({ slots, generatePrompts, savePrompts, beforeRender = () => {}, render, failed, complete }) {
  const prompts = await generatePrompts();
  await savePrompts(prompts);
  for (const slot of slots) {
    await beforeRender(slot);
    try { await render(slot, prompts.get(slot.id)); }
    catch (error) { await failed(slot, error); }
    await complete(slot);
  }
}
