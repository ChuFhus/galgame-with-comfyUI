/**
 * 群聊被点名成员的私聊资料（dossier）
 *
 * 用户在群里 @/明确提到某个角色时，抓取该角色私聊的「最近一条滚动摘要 + 最近 5 轮对话」
 * 作为一份资料注入本轮群聊 prompt（<private_chat_dossiers> 标签）。轮数按角色的
 * assistant raw 计，中间用户是否发言不影响。
 *
 * 有效期规则：
 *   - 资料自注入起持续携带 3 轮（每生成一轮倒计时一次，user/idle/lull/opening 都算一轮）；
 *   - 重复点名同一角色会重新抓取最新私聊数据并把该角色的有效期重置为 3；
 *   - 各成员的有效期独立统计，点谁注入谁、到期各自移除。
 *
 * 资料内容只含私聊摘要与对话文本，不含角色人格 prompt（人格由群信息块单独提供）。
 * 缓存存于进程内存（groupId -> Map(characterId -> entry)），重启后丢失、重新点名即恢复。
 */
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { getRecentSummaries } from './summarizer.js';
import { stripBracePromptBlocks } from '../utils/groupImagePrompt.js';

const DOSSIER_TTL_ROUNDS = 3;      // 资料有效期：持续携带的轮数
const DOSSIER_FETCH_ROUNDS = 5;    // 抓取的私聊对话轮数
const DOSSIER_MAX_CHARS = 1600;    // 单份资料的最大字符数（超出时从最早的对白开始省略）

const dossierCache = new Map(); // groupId -> Map(characterId -> { characterName, text, remainingRounds })

function cacheFor(groupId) {
  const key = Number(groupId);
  let cache = dossierCache.get(key);
  if (!cache) {
    cache = new Map();
    dossierCache.set(key, cache);
  }
  return cache;
}

/** 测试与撤回场景用：清空某群的资料缓存 */
export function resetMentionDossiers(groupId) {
  dossierCache.delete(Number(groupId));
}

/** 测试注入用：直接写入/刷新一份资料（跳过 DB 抓取） */
export function refreshDossierEntry(groupId, characterId, characterName, text) {
  if (!text) return;
  cacheFor(groupId).set(Number(characterId), {
    characterName,
    text,
    remainingRounds: DOSSIER_TTL_ROUNDS,
  });
}

/**
 * 点名发生时调用：为每个被点名的成员重新抓取私聊资料并刷新有效期。
 * 私聊没有任何可用内容（无摘要也无对白）的成员不注入。
 */
export function refreshMentionDossiers(group, mentionedMembers) {
  const refreshed = [];
  for (const member of mentionedMembers || []) {
    const text = buildMemberDossierText(member);
    if (!text) continue;
    refreshDossierEntry(group.id, member.id, member.display_name, text);
    refreshed.push(member.display_name);
  }
  if (refreshed.length > 0) {
    console.log(`[dossier] group ${group.id} refreshed private dossiers for: ${refreshed.join('、')} (TTL reset to ${DOSSIER_TTL_ROUNDS} rounds)`);
  }
}

/**
 * 奇遇分享卡片气泡只写 messages（raw_id 为 NULL），raw_messages 天然不含卡片，
 * 因此资料直接从 raw_messages 取对白，无需再过滤奇遇 JSON。
 */
export function fetchRecentPrivateRounds(conversationId, rounds = DOSSIER_FETCH_ROUNDS) {
  const db = getDb();
  // 轮数按角色的 assistant raw 计：最近 rounds 条角色回复，中间用户是否发言不影响轮数；
  // 窗口内夹着的用户消息一并带上，保持对话完整
  const assistantRaws = db.prepare(`
    SELECT id FROM raw_messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY id DESC LIMIT ?
  `).all(conversationId, rounds);
  if (assistantRaws.length === 0) return [];
  const startId = assistantRaws[assistantRaws.length - 1].id;
  return db.prepare(`
    SELECT role, content FROM raw_messages
    WHERE conversation_id = ? AND id >= ? AND role IN ('user','assistant')
    ORDER BY id ASC
  `).all(conversationId, startId);
}

function buildMemberDossierText(member) {
  const db = getDb();
  const conversationId = `char_${member.id}`;
  const chatUserName = config.user.nickname || '用户';

  const summary = (getRecentSummaries(conversationId, 1)[0]?.summary || '').trim();
  const dialogueLines = fetchRecentPrivateRounds(conversationId).map(row => {
    // raw 里粘着生图 prompt（台词后跟 {"prompt":"..."} 或 {...} 块），喂给模型前清掉、只留真实发言
    const body = stripBracePromptBlocks(row.content).trim();
    if (!body) return null;
    const speaker = row.role === 'user' ? chatUserName : member.display_name;
    return `${speaker}：${body}`;
  }).filter(Boolean);

  if (!summary && dialogueLines.length === 0) return '';

  const parts = [];
  parts.push(`【${chatUserName}与「${member.display_name}」的私聊资料】`);
  if (summary) parts.push(`最近对话摘要：\n${summary}`);
  if (dialogueLines.length > 0) {
    let lines = dialogueLines;
    // 从最早的对白开始省略，控制单份资料体积
    while (lines.join('\n').length > DOSSIER_MAX_CHARS && lines.length > 1) {
      lines = lines.slice(1);
    }
    parts.push(`最近私聊记录：\n${lines.join('\n')}`);
  }
  return parts.join('\n');
}

/**
 * 每轮生成时调用：返回本轮要注入的 <private_chat_dossiers> 指令块（无有效资料时返回空串）。
 * 副作用：所有有效资料消耗一轮倒计时，归零移除（各成员独立）。
 */
export function buildMentionDossierBlock(groupId) {
  const cache = dossierCache.get(Number(groupId));
  if (!cache || cache.size === 0) return '';

  const entries = [...cache.values()];
  for (const [characterId, entry] of cache) {
    entry.remainingRounds -= 1;
    if (entry.remainingRounds <= 0) cache.delete(characterId);
  }
  console.log(`[dossier] group ${groupId} consumed a round; active dossiers: ${
    entries.map(e => `${e.characterName}(${Math.max(0, e.remainingRounds)} left)`).join('、') || 'none'
  }`);

  const chatUserName = config.user.nickname || '用户';
  const intro = `以下是${chatUserName}与部分角色的私聊资料。每份资料只有对应的角色本人知道这些内容，其他角色没有看过这些私聊，不要替其他角色复述或引用其中的细节；对应角色可以在群聊中自然地想起、提及自己私下聊过的事：`;
  return `<private_chat_dossiers>\n${intro}\n\n${entries.map(e => e.text).join('\n\n')}\n</private_chat_dossiers>`;
}
