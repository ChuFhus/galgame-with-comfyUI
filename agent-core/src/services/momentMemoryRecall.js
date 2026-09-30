import { config } from '../config.js';
import { hybridSearch } from './memorySearch.js';

// 朋友圈回评的 RAG 检索限时：超时即放弃注入，不阻塞回评主流程。
export const MOMENT_RAG_TIMEOUT_MS = 1200;
// 单路查询召回条数（朋友圈文案、评论区内容各查一次）。
export const MOMENT_RAG_TOPK = 5;

// 事件 / 奇遇 / 未互动事件类记忆由主聊天流、群聊的 <rag_memories> 注入，朋友圈回评不重复注入。
function isInjectableMemory(memory) {
  const judgment = String(memory?.judgment ?? '');
  return !(
    judgment.includes('【事件】')
    && judgment.includes('【奇遇】')
    && judgment.includes('未互动事件')
  );
}

function normalizeQuery(text) {
  return String(text ?? '').trim();
}

// 给单路检索加超时兜底：超时按“无结果”处理，绝不把异常抛给回评主流程。
function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 检索「发帖人」的 RAG 记忆，用于喂给即将回评的角色：
 * 分别以「朋友圈文案」和「评论区内容」为查询词检索帖主的记忆，再按 memory_id 合并去重。
 * @param {string|string[]} conversationIds 发帖人的记忆会话范围（如 char-3）
 * @param {{ postText?: string, commentText?: string|string[] }} queries 两路查询词
 * @param {{ hybridSearch?: Function, timeoutMs?: number }} deps 可注入的检索实现与超时（测试用）
 * @returns {Promise<Array<object>>} 记忆条目；特性关闭 / 无查询词 / 超时 / 失败时为空数组
 */
export async function recallMomentMemories(conversationIds, { postText, commentText } = {}, deps = {}) {
  if (!config.features.memory) return [];

  const scope = (Array.isArray(conversationIds) ? conversationIds : [conversationIds]).filter(Boolean);
  if (!scope.length) return [];

  const commentQuery = Array.isArray(commentText) ? commentText.filter(Boolean).join(' ') : commentText;
  const queries = [postText, commentQuery].map(normalizeQuery).filter(Boolean);
  if (!queries.length) return [];

  const search = deps.hybridSearch || hybridSearch;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : MOMENT_RAG_TIMEOUT_MS;

  const batches = await Promise.all(queries.map(async (query) => {
    try {
      const hits = await withTimeout(
        Promise.resolve().then(() => search(query, { conversationIds: scope, topk: MOMENT_RAG_TOPK })),
        timeoutMs,
      );
      return Array.isArray(hits) ? hits : [];
    } catch (error) {
      console.error('[momentComment] 记忆检索失败：', error?.message || error);
      return [];
    }
  }));

  const merged = new Map();
  for (const memory of batches.flat()) {
    const id = memory?.memory_id ?? memory?.id;
    if (id == null || merged.has(id) || !isInjectableMemory(memory)) continue;
    merged.set(id, memory);
  }
  return [...merged.values()];
}

/**
 * 把检索到的记忆渲染成注入块：告诉即将回评的角色「发帖人经历过什么」。
 * @param {Array<object>} memories 发帖人的记忆条目
 * @param {string} authorName 发帖人名字
 * @returns {string} <rag_memories> 文本块
 */
export function formatMomentMemories(memories, authorName) {
  const who = String(authorName ?? '').trim() || 'TA';
  const lines = (memories || [])
    .map((memory, index) => `${index + 1}. [${memory.memory_type}] ${memory.judgment}`)
    .join('\n');
  return `<rag_memories>\n${who}经历过的事情：\n${lines}\n</rag_memories>`;
}
