export const STANDING_PREFIX = 'full body, head to toe, white background, simple background';

export function parseStandingPrompts(raw, slots) {
  const parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!Array.isArray(parsed.prompts) || parsed.prompts.length !== slots.length) throw new Error('立绘提示词数量不完整，请重试');
  const expected = new Set(slots.map(s => s.id));
  const result = new Map();
  for (const item of parsed.prompts) {
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!expected.has(item.slotId) || result.has(item.slotId) || prompt.length < 10 || prompt.length > 800 || /[\u3400-\u9fff]/u.test(prompt)) throw new Error('立绘提示词格式或内容不完整，请重试');
    result.set(item.slotId, `${STANDING_PREFIX}, ${prompt}`);
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
