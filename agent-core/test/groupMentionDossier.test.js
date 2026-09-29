import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const dossier = await import('../src/services/groupMentionDossier.js');
const { resetMentionDossiers, refreshDossierEntry, refreshMentionDossiers, buildMentionDossierBlock } = dossier;

test('dossier persists for 3 rounds then expires', () => {
  resetMentionDossiers(1);
  refreshDossierEntry(1, 11, '小雪', '【用户与「小雪」的私聊资料】\n最近对话摘要：\n聊过烟花大会');

  assert.match(buildMentionDossierBlock(1), /小雪/);          // 第 1 轮（点名当轮）
  assert.match(buildMentionDossierBlock(1), /小雪/);          // 第 2 轮
  assert.match(buildMentionDossierBlock(1), /小雪/);          // 第 3 轮
  assert.equal(buildMentionDossierBlock(1), '');              // 第 4 轮已过期
});

test('re-mention refreshes the countdown to 3 rounds', () => {
  resetMentionDossiers(2);
  refreshDossierEntry(2, 21, '阿澄', '【用户与「阿澄」的私聊资料】\n最近对话摘要：\n聊过健身餐');

  buildMentionDossierBlock(2); // 第 1 轮
  refreshDossierEntry(2, 21, '阿澄', '【用户与「阿澄」的私聊资料】\n最近对话摘要：\n聊过健身餐（已刷新）');
  buildMentionDossierBlock(2); // 第 2 轮（刷新后重新计 3）
  buildMentionDossierBlock(2); // 第 3 轮
  assert.match(buildMentionDossierBlock(2), /阿澄/);          // 刷新后的第 3 轮仍在
  assert.equal(buildMentionDossierBlock(2), '');
});

test('each member has an independent countdown', () => {
  resetMentionDossiers(3);
  refreshDossierEntry(3, 31, '小雪', '资料A');
  refreshDossierEntry(3, 32, '阿澄', '资料B');

  let block = buildMentionDossierBlock(3); // 第 1 轮
  assert.match(block, /资料A/);
  assert.match(block, /资料B/);

  // 中途点名另一个人：只有新资料被刷新
  refreshDossierEntry(3, 33, '凛', '资料C');
  block = buildMentionDossierBlock(3); // 第 2 轮
  assert.match(block, /资料A/);
  assert.match(block, /资料B/);
  assert.match(block, /资料C/);

  // A、B 携带满第 3 轮，第 4 轮消失；C（第 2 轮被点名）还剩两轮
  block = buildMentionDossierBlock(3); // 第 3 轮
  assert.match(block, /资料A/);
  assert.match(block, /资料B/);
  assert.match(block, /资料C/);
  block = buildMentionDossierBlock(3); // 第 4 轮
  assert.doesNotMatch(block, /资料A/);
  assert.doesNotMatch(block, /资料B/);
  assert.match(block, /资料C/);
  assert.equal(buildMentionDossierBlock(3), ''); // 第 6 轮全部过期
});

test('dossier block explains the knowledge boundary', () => {
  resetMentionDossiers(4);
  refreshDossierEntry(4, 41, '小雪', '【用户与「小雪」的私聊资料】\n最近对话摘要：\n聊过烟花大会');
  const block = buildMentionDossierBlock(4);
  assert.match(block, /<private_chat_dossiers>/);
  assert.match(block, /<\/private_chat_dossiers>/);
  assert.match(block, /只有对应的角色本人知道/);
});

test('private dossier reads raw_messages: rounds count by assistant replies, no event cards', async () => {
  const { getDb } = await import('../src/db/index.js');
  const db = getDb();
  const convId = 'char_99002';
  const insertRaw = db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)`
  );

  // 3 个角色回复轮：第 1、2 轮之间夹一条用户发言，第 2、3 轮之间用户没说话
  insertRaw.run(convId, 'assistant', '在整理花园呢');
  insertRaw.run(convId, 'user', '最近在忙什么？');
  insertRaw.run(convId, 'assistant', '昨天那场雨把花打落了不少');
  // raw 里台词和 {"prompt":...} 生图 JSON 粘在同一行：prompt 清掉、台词保留
  insertRaw.run(convId, 'assistant', '不过也凉快了些{"prompt":"a girl watering flowers in a garden"}');

  // 奇遇卡片只存在于 messages 表（raw_id NULL），不应泄漏进资料
  db.prepare(
    `INSERT INTO messages (conversation_id, raw_id, role, content, seq, is_proactive, event_id) VALUES (?, NULL, 'assistant', ?, 1, 1, 4242)`
  ).run(convId, JSON.stringify({
    title: '奇遇卡片标题',
    description: '奇遇卡片描述正文，不应该出现在资料里',
    image: '/images/events/event_x.png',
    expires_at: '2026-09-09 18:53:00',
  }));

  resetMentionDossiers(6);
  refreshMentionDossiers({ id: 6 }, [{ id: 99002, display_name: '测试角色' }]);
  const block = buildMentionDossierBlock(6);

  assert.match(block, /在整理花园呢/);
  assert.match(block, /昨天那场雨把花打落了不少/);
  assert.match(block, /不过也凉快了些/);            // 台词保留
  assert.doesNotMatch(block, /a girl watering flowers/); // 生图 prompt 清除
  assert.doesNotMatch(block, /"prompt"/);
  assert.match(block, /最近在忙什么？/);          // 窗口内夹着的用户消息一并保留
  assert.doesNotMatch(block, /奇遇卡片描述正文/);   // raw 口径天然无卡片
  assert.doesNotMatch(block, /"expires_at"/);
});


