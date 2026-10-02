import { randomUUID } from 'node:crypto';

export const TOUCH_PARTS = { head: '头顶', face: '脸', shoulder: '肩颈', hand: '手', chest: '胸口', belly: '肚子', butt: '屁股和下体', thigh: '大腿', calf: '小腿', foot: '脚' };

export function buildTouchLineMessages(character, { systemRules = '', worldRule = '', relationship = null, userName = '用户' } = {}) {
  const example = Object.fromEntries(Object.entries(TOUCH_PARTS).map(([key, label]) => [key,
    Array.from({ length: 3 }, () => `${label}被轻触时的角色对白，4–32字，符合人设，三句不重复，单行字符串`)]));
  const relationshipContext = `\n\n角色与用户的当前关系：\n用户称呼：${userName}\n角色是用户的：${relationship?.relationship_text?.trim() || '尚未设定关系'}\n角色对用户的好感度：${relationship?.affinity ?? 50}/100\n是否誓约：${relationship?.is_oath ? '已誓约' : '未誓约'}\n依据当前关系、好感度与角色人格决定称呼、语气和亲近程度，将这些背景自然体现在台词中。`;
  return [
    { role: 'system', content: systemRules },
    { role: 'system', content: worldRule },
    { role: 'system', content: `为角色立绘的小窗空手触摸生成反应台词。每个部位恰好三句不同的简短中文对白，使用角色本人的口吻与称呼习惯，根据角色人格和当前关系自然发挥。\n输出结构（字段名必须逐字照抄）：\n1. 根对象只能有一个字段 lines，lines 必须是对象，不能是数组。\n2. lines 恰好包含以下 10 个英文键：${Object.keys(TOUCH_PARTS).join(', ')}。不要用中文部位名作为键，不要添加其他字段。\n3. 字段对应关系：${Object.entries(TOUCH_PARTS).map(([key,label]) => `${key}=${label}`).join('；')}。肩膀和颈部已合并，统一写 shoulder，禁止另写 neck、neck_shoulder 或 shoulders。\n4. 每个键的值只能是三个字符串组成的数组，不能写成对象，不能添加 text、dialogue、部位名称等嵌套字段。共 10 组、30 句。\n5. 将下方每个示例字符串替换为真正的角色台词；示例中的要求不是台词，不能原样输出。每句 4–32 字，无旁白、无换行，同一部位三句不重复。\n6. 输出前自行检查所有 10 个键齐全、每组恰好三句。严格按以下完整 JSON 示例输出，不要 Markdown、解释或 JSON 以外文字。\n${JSON.stringify({ lines: example }, null, 2)}` },
    { role: 'system', content: `角色：${character.display_name || character.name}\n角色人格：\n${character.base_prompt || character.short_prompt || '自然、简短地回应。'}` },
    { role: 'user', content: `${relationshipContext}\n\n请按照 <world_setting> 中的世界观设定设计台词，体现其中的背景、规则、称谓与表达习惯，并结合以上角色人格和当前关系生成完整的 30 句触摸反馈台词。严格按前述 JSON 格式输出。` },
  ];
}

export function parseTouchLines(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || Object.keys(value).join() !== 'lines' || !value.lines || Array.isArray(value.lines)) throw new Error('触摸台词 JSON 格式无效');
  const keys = Object.keys(TOUCH_PARTS);
  const missing = keys.filter(k => !Object.hasOwn(value.lines, k));
  const extra = Object.keys(value.lines).filter(k => !keys.includes(k));
  if (missing.length || extra.length) throw new Error(`触摸台词字段不匹配${missing.length ? `；缺少：${missing.map(k => `${k}（${TOUCH_PARTS[k]}）`).join('、')}` : ''}${extra.length ? `；多余：${extra.join('、')}` : ''}`);
  return Object.fromEntries(keys.map(key => {
    const list = value.lines[key];
    if (!Array.isArray(list) || list.length !== 3 || list.some(s => typeof s !== 'string' || [...s.trim()].length < 4 || [...s.trim()].length > 32 || /[\r\n]/.test(s))) throw new Error(`${TOUCH_PARTS[key]}需要三句 4–32 字的台词`);
    const trimmed = list.map(s => s.trim());
    if (new Set(trimmed).size !== 3) throw new Error(`${TOUCH_PARTS[key]}台词不能重复`);
    return [key, trimmed];
  }));
}

export function readTouchLines(db, id) {
  const row = db.prepare('SELECT request_id,status,lines_json,error FROM character_standing_touch_lines WHERE character_id=?').get(id);
  let lines = null;
  try { if (row?.lines_json) {
    const stored = JSON.parse(row.lines_json);
    // Older sets split neck and shoulder; preserve the shoulder pool without another LLM call.
    delete stored.neck;
    lines = parseTouchLines({ lines: stored });
  } } catch { /* Corrupt old data must not break the display. */ }
  return { status: row?.status || 'empty', lines, error: row?.error || null, version: row?.request_id || null };
}

export function saveTouchLines({ db, id, lines, expectedVersion, emit = () => {} }) {
  const fail = (message,status) => { throw Object.assign(new Error(message),{status}); };
  let normalized;
  try { normalized=parseTouchLines({lines}); } catch(error) { fail(error.message,400); }
  const result=db.transaction(()=>{
    if(!db.prepare('SELECT id FROM characters WHERE id=?').get(id))fail('角色不存在',404);
    const current=readTouchLines(db,id);
    if(current.status==='generating')fail('台词正在生成，请完成后再编辑',409);
    if(expectedVersion!==current.version)fail('台词已更新，请重新读取后再保存',409);
    db.prepare(`INSERT INTO character_standing_touch_lines(character_id,request_id,status,lines_json) VALUES(?,?,'ready',?)
      ON CONFLICT(character_id) DO UPDATE SET request_id=excluded.request_id,status='ready',lines_json=excluded.lines_json,error=NULL,updated_at=CURRENT_TIMESTAMP`).run(id,randomUUID(),JSON.stringify(normalized));
    return readTouchLines(db,id);
  })();
  emit('expression_standings_updated',{characterId:Number(id),scope:'touch-lines'});
  return result;
}

// One independent background task for the entire set, never one call per touch.
export function startTouchLines({ db, character, generate, emit = () => {} }) {
  const id = character.id;
  if (readTouchLines(db, id).status === 'generating') return null;
  const requestId = randomUUID();
  db.prepare(`INSERT INTO character_standing_touch_lines(character_id,request_id,status) VALUES(?,?,'generating')
    ON CONFLICT(character_id) DO UPDATE SET request_id=excluded.request_id,status='generating',error=NULL,updated_at=CURRENT_TIMESTAMP`).run(id, requestId);
  const notify = () => emit('expression_standings_updated', { characterId: id, scope: 'touch-lines' });
  notify();
  return Promise.resolve().then(() => generate(character)).then(raw => {
    const lines = parseTouchLines(raw);
    const result = db.prepare("UPDATE character_standing_touch_lines SET lines_json=?,status='ready',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE character_id=? AND request_id=?").run(JSON.stringify(lines), id, requestId);
    if (result.changes) notify();
  }).catch(error => {
    const result = db.prepare("UPDATE character_standing_touch_lines SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE character_id=? AND request_id=?").run(String(error.message || '台词生成失败').slice(0, 200), id, requestId);
    if (result.changes) notify();
  });
}
