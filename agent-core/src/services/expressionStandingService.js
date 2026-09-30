import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { getDb, getSystemRules, getSystemRulesWithWorld, getWorldSetting } from '../db/index.js';
import { config } from '../config.js';
import { chatSync } from '../llm/llm-client.js';
import { buildCharacterPersona } from './characterPersona.js';
import { buildStandingPromptMessages } from './expressionStandingPrompt.js';
import { charArtistOverride } from './characterImageOpts.js';
import { parseCharacterLoras } from './emojiService.js';
import { generateImageRaw, captureImageGenerationConfig } from './imageSkill.js';
import { refineImage } from './imageRefine.js';
import { getImageDir, buildImageUrl, deleteImageFileByUrl } from './imagePaths.js';
import { postProcessAsset } from './town/assetPostProcess.js';
import { broadcast } from './unifiedStreamBus.js';
import { getStandingDisplay } from './standingDisplay.js';
import { parseStandingPrompts, runStandingBatch, frameStandingPrompt } from './expressionStandingPipeline.js';

const CATEGORY = 'expression_standing';
const busyCharacters = new Set();
const batchControls = new Map();
const PAUSED = Symbol('standing task paused');
let queue = Promise.resolve();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function standingSlots(db = getDb()) {
  return [{ id: 'normal', name: '正常' }, ...db.prepare('SELECT id,emoji_key FROM emoji_categories ORDER BY sort_order,id').all().map(r => ({ id: `emoji:${r.id}`, name: r.emoji_key }))];
}
function character(id) {
  const row = getDb().prepare('SELECT * FROM characters WHERE id=?').get(id);
  if (!row) throw fail('角色不存在', 404);
  return row;
}
function ensureSlot(id, slot) {
  character(id);
  if (!standingSlots().some(s => s.id === slot)) throw fail('立绘槽位不存在', 404);
  getDb().prepare('INSERT OR IGNORE INTO character_expression_standings(character_id,slot_id) VALUES(?,?)').run(id, slot);
  return getDb().prepare('SELECT * FROM character_expression_standings WHERE character_id=? AND slot_id=?').get(id, slot);
}
function assertIdle(id) {
  if (busyCharacters.has(Number(id))) throw fail('角色立绘任务正在进行，请完成后再编辑', 409);
}
function notify(id) {
  broadcast('expression_standings_updated', { characterId: Number(id) });
  getStandingDisplay().refresh();
}
export function listExpressionStandings(id) {
  character(id);
  const rows = getDb().prepare('SELECT * FROM character_expression_standings WHERE character_id=?').all(id);
  return {
    slots: standingSlots().map(s => {
      const row = rows.find(r => r.slot_id === s.id);
      return { ...s, ...row, generation: JSON.parse(row?.config_json || '{}'), bounds: JSON.parse(row?.bounds_json || 'null') };
    }),
    jobs: getDb().prepare('SELECT * FROM expression_standing_jobs WHERE character_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10').all(id).map(job => ({ ...job, resumable: job.status === 'failed' && job.error === '服务重启导致生成中断，请重试' })),
    busy: busyCharacters.has(Number(id)),
  };
}

function snapshotConfig(char) {
  return structuredClone({ ...captureImageGenerationConfig('portrait'), artist: charArtistOverride(char) ?? config.comfyui.momentsArtist, loras: parseCharacterLoras(char), ...(char.custom_workflow ? { customWorkflow: char.custom_workflow } : {}), width: 768, height: 1536 });
}
export async function generateStandingPrompts(char, slots, requirement, persona = buildCharacterPersona(char, { variant: 'short', person: char.display_name })) {
  const messages = buildStandingPromptMessages({
    systemRules: getWorldSetting() ? getSystemRulesWithWorld({ roleplay: false }) : getSystemRules({ roleplay: false }),
    slots, persona, requirement,
  });
  const raw = await chatSync(messages, { temperature: 0.7, max_tokens: Math.min(8192, Math.max(2048, slots.length * 512 + 512)), response_format: { type: 'json_object' }, label: '批量立绘提示词' });
  return parseStandingPrompts(raw, slots);
}

async function commitImage(id, slot, buffer, { removeBg = true, source = true } = {}) {
  const previous = ensureSlot(id, slot); // Deleted characters must never be resurrected by a late job.
  const sourceBuffer = buffer;
  let image = sharp(buffer, { limitInputPixels: 67108864 });
  const originalMeta = await image.metadata();
  // Match the town illustration limit, preserving aspect ratio and smooth alpha.
  if (Math.max(originalMeta.width, originalMeta.height) > 4096) {
    buffer = await image.resize(4096, 4096, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    image = sharp(buffer);
  }
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw fail('图片格式无效');
  const stats = await image.stats();
  const transparent = meta.hasAlpha && !stats.isOpaque;
  const output = await postProcessAsset(buffer, { removeBg: removeBg && !transparent });
  const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 8) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  const bounds = right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1, imageWidth: info.width, imageHeight: info.height } : null;
  const filename = `char_${id}_${slot.replace(':', '_')}_${randomUUID()}.png`;
  const dir = getImageDir(CATEGORY);
  fs.mkdirSync(dir, { recursive: true });
  const url = buildImageUrl(CATEGORY, filename);
  const sourceName = `source_${filename}`;
  try {
    fs.writeFileSync(path.join(dir, filename), output);
    if (source) fs.writeFileSync(path.join(dir, sourceName), await sharp(sourceBuffer, { limitInputPixels: 67108864 }).png().toBuffer());
    const result = getDb().prepare(`UPDATE character_expression_standings SET image_url=?,source_url=CASE WHEN ? IS NULL THEN source_url ELSE ? END,bounds_json=?,status='done',error=NULL,version=version+1 WHERE character_id=? AND slot_id=? AND version=?`).run(url, source ? sourceName : null, source ? buildImageUrl(CATEGORY, sourceName) : null, JSON.stringify(bounds), id, slot, previous.version);
    if (!result.changes) throw fail('立绘已被修改或角色已删除，请刷新', 409);
  } catch (error) {
    for (const file of [filename, sourceName]) { try { fs.unlinkSync(path.join(dir, file)); } catch {} }
    throw error;
  }
  for (const old of [previous.image_url, source ? previous.source_url : null]) {
    if (old) { try { deleteImageFileByUrl(old); } catch { /* A stale file must not invalidate the committed image. */ } }
  }
  notify(id);
}

export function startStandingBatch(id, { slotIds, requirement = '', reusePrompts = false } = {}, { promptGenerator = generateStandingPrompts, imageGenerator = generateImageRaw } = {}) {
  id = Number(id); assertIdle(id);
  const char = character(id);
  const all = standingSlots();
  const selected = slotIds === undefined ? all.map(s => s.id) : slotIds;
  if (!Array.isArray(selected) || !selected.length || selected.some(s => !all.some(a => a.id === s))) throw fail('请选择有效立绘槽位');
  const slots = all.filter(s => selected.includes(s.id));
  const rows = slots.map(s => ensureSlot(id, s.id));
  if (reusePrompts && rows.some(r => !r.prompt.trim())) throw fail('请先生成或保存提示词');
  requirement = String(requirement).trim().slice(0, 2000);
  const generation = snapshotConfig(char);
  const persona = buildCharacterPersona(char, { variant: 'short', person: char.display_name });
  const db = getDb();
  const jobId = randomUUID();
  db.prepare(`INSERT INTO expression_standing_jobs(id,character_id,slots_json,status,request_json) VALUES(?,?,?,'queued',?)`).run(jobId, id, JSON.stringify(slots.map(s => s.id)), JSON.stringify({ requirement, promptsReady: reusePrompts }));
  busyCharacters.add(id);
  const control = { jobId, pauseRequested: false, paused: false, cursor: 0, failures: 0, prompts: null, run: null };
  batchControls.set(id, control);
  notify(id);
  const run = async () => {
    try {
      if (control.pauseRequested) throw PAUSED;
      db.prepare('UPDATE expression_standing_jobs SET status=? WHERE id=?').run(control.prompts || reusePrompts ? 'generating' : 'prompts', jobId);
      notify(id);
      await runStandingBatch({
        slots: slots.slice(control.cursor),
        generatePrompts: () => control.prompts || (reusePrompts ? new Map(rows.map(r => [r.slot_id, r.prompt])) : promptGenerator(char, slots, requirement, persona)),
        savePrompts: prompts => {
          if (control.prompts) return;
          db.transaction(() => {
            for (const slot of slots) {
              const old = rows.find(r => r.slot_id === slot.id);
              db.prepare(`UPDATE character_expression_standings SET prompt=?,requirement=?,config_json=?,status='queued',error=NULL WHERE character_id=? AND slot_id=?`).run(prompts.get(slot.id), reusePrompts ? old.requirement : requirement, reusePrompts && old.config_json !== '{}' ? old.config_json : JSON.stringify(generation), id, slot.id);
            }
            db.prepare(`UPDATE expression_standing_jobs SET status='generating',request_json=? WHERE id=?`).run(JSON.stringify({ requirement, promptsReady: true }), jobId);
          })();
          control.prompts = prompts;
          notify(id);
        },
        beforeRender: () => { if (control.pauseRequested) throw PAUSED; },
        render: async (slot, prompt) => {
          const row = ensureSlot(id, slot.id);
          db.prepare(`UPDATE character_expression_standings SET status='generating' WHERE character_id=? AND slot_id=?`).run(id, slot.id);
          notify(id);
          const opts = JSON.parse(row.config_json);
          // 最终阀门：不论提示词来自本次生成、库里复用还是用户手改，进 ComfyUI 前一律补上固定前置（solo 开头）。
          const framedPrompt = frameStandingPrompt(prompt);
          const result = await imageGenerator(framedPrompt, { ...opts, scene: 'portrait', workflowScene: null, promptScene: 'avatar', priority: 'high', disableRAG: true, alreadyPrepared: true, persistPreparation: false });
          if (!result.success || !result.images?.length) throw new Error(result.error || '未返回立绘图片');
          await commitImage(id, slot.id, decodeImage(result.images[0].base64));
        },
        failed: (slot, error) => {
          control.failures++;
          db.prepare(`UPDATE character_expression_standings SET status='failed',error=? WHERE character_id=? AND slot_id=?`).run(error.message, id, slot.id);
          notify(id);
        },
        complete: () => { control.cursor++; db.prepare('UPDATE expression_standing_jobs SET completed=completed+1 WHERE id=?').run(jobId); notify(id); },
      });
      db.prepare('UPDATE expression_standing_jobs SET status=? WHERE id=?').run(control.failures ? 'partial_failed' : 'done', jobId);
    } catch (error) {
      if (error === PAUSED) {
        control.paused = true;
        db.prepare(`UPDATE expression_standing_jobs SET status='paused' WHERE id=?`).run(jobId);
      } else db.prepare(`UPDATE expression_standing_jobs SET status='failed',error=? WHERE id=?`).run(error.message, jobId);
    } finally {
      if (!control.paused) { busyCharacters.delete(id); batchControls.delete(id); }
      notify(id);
    }
  };
  control.run = run;
  queue = queue.then(run, run);
  return { jobId };
}

export function controlStandingBatch(id, jobId, action, dependencies) {
  id = Number(id);
  const control = batchControls.get(id);
  if (!control && action === 'resume') {
    assertIdle(id);
    const db = getDb();
    const job = db.prepare('SELECT * FROM expression_standing_jobs WHERE id=? AND character_id=?').get(jobId, id);
    const latest = db.prepare('SELECT id FROM expression_standing_jobs WHERE character_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
    if (!job || latest?.id !== jobId || job.status !== 'failed' || job.error !== '服务重启导致生成中断，请重试') throw fail('该任务已结束或已有更新任务', 409);
    const request = JSON.parse(job.request_json || '{}');
    const valid = new Set(standingSlots().map(s => s.id));
    const ids = JSON.parse(job.slots_json).filter(key => valid.has(key));
    const allRows = ids.map(key => ensureSlot(id, key));
    const ready = request.promptsReady ?? allRows.every(r => r.prompt.trim() && ['failed', 'queued', 'generating', 'done'].includes(r.status));
    const remaining = ids.filter((key, index) => {
      const row = allRows[index];
      if (!ready) return true;
      // Include failed attempts before the cursor, but never regenerate a committed image.
      return row.status === 'failed' || (index >= job.completed && row.status !== 'done');
    });
    if (!remaining.length) {
      db.prepare("UPDATE expression_standing_jobs SET status='done',error=NULL WHERE id=?").run(jobId);
      notify(id); return { ok: true, jobId };
    }
    const result = startStandingBatch(id, { slotIds: remaining, requirement: request.requirement ?? allRows[0]?.requirement ?? '', reusePrompts: ready }, dependencies);
    db.prepare("UPDATE expression_standing_jobs SET status='resumed',error=NULL WHERE id=?").run(jobId);
    return { ok: true, ...result };
  }
  if (!control || control.jobId !== jobId) throw fail('任务已结束或服务已重启，请重新生成', 409);
  if (action === 'stop') {
    control.pauseRequested = true;
    if (!control.paused) getDb().prepare(`UPDATE expression_standing_jobs SET status='stopping' WHERE id=?`).run(jobId);
  } else if (action === 'resume') {
    if (!control.paused) throw fail('请等待当前步骤完成后继续任务', 409);
    control.pauseRequested = false;
    control.paused = false;
    getDb().prepare(`UPDATE expression_standing_jobs SET status='queued' WHERE id=?`).run(jobId);
    queue = queue.then(control.run, control.run);
  } else throw fail('无效的任务操作');
  notify(id);
  return { ok: true };
}

export function decodeImage(value) {
  if (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/i.test(value)) throw fail('需要 PNG、JPEG 或 WebP 图片');
  return Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
}
export function updateStandingPrompt(id, slot, prompt, generation) {
  assertIdle(id); ensureSlot(id, slot);
  if (typeof prompt !== 'string' || prompt.trim().length < 10 || prompt.length > 4000) throw fail('提示词需为 10–4000 字符');
  const row = ensureSlot(id, slot);
  const old = { ...snapshotConfig(character(id)), ...JSON.parse(row.config_json) };
  const next = generation ? { ...old, artist: String(generation.artist ?? old.artist ?? ''), loras: Array.isArray(generation.loras) ? generation.loras : old.loras } : old;
  getDb().prepare('UPDATE character_expression_standings SET prompt=?,config_json=? WHERE character_id=? AND slot_id=?').run(prompt.trim(), JSON.stringify(next), id, slot);
  notify(id);
}
export async function editStandingImage(id, slot, action, payload = {}) {
  id = Number(id); assertIdle(id);
  const row = ensureSlot(id, slot);
  busyCharacters.add(id);
  try {
    if (action === 'upload' || action === 'image') {
      await commitImage(id, slot, decodeImage(payload.image), { removeBg: action === 'upload', source: action === 'upload' });
    } else {
      if (!row.image_url) throw fail('立绘尚未生成');
      let filePath = path.join(getImageDir(CATEGORY), path.basename(row.image_url));
      if (!fs.existsSync(filePath)) filePath = filePath.replace(/\.png$/i, '.avif');
      const buffer = fs.readFileSync(filePath);
      if (action === 'crop') {
        const { x, y, w, h } = payload;
        if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1) throw fail('裁剪范围无效');
        await commitImage(id, slot, await sharp(buffer).extract({ left: x, top: y, width: w, height: h }).png().toBuffer(), { removeBg: false, source: false });
      } else if (action === 'hires') {
        if (!row.prompt) throw fail('请先保存提示词');
        const result = await refineImage({ ...JSON.parse(row.config_json), buffer, ext: path.extname(filePath), promptText: row.prompt, scene: 'portrait', workflowScene: null, output: 'buffer' });
        await commitImage(id, slot, decodeImage(result.base64));
      } else throw fail('未知图片操作');
    }
  } finally { busyCharacters.delete(id); notify(id); }
}
export function deleteStanding(id, slot) {
  assertIdle(id); const row = ensureSlot(id, slot);
  getDb().prepare(`UPDATE character_expression_standings SET image_url=NULL,source_url=NULL,bounds_json=NULL,status='empty',error=NULL,version=version+1 WHERE character_id=? AND slot_id=?`).run(id, slot);
  for (const url of [row.image_url, row.source_url]) if (url) { try { deleteImageFileByUrl(url); } catch {} }
  notify(id);
}
