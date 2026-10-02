import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-standing-test-'));
process.env.DB_PATH = ':memory:';
process.env.IMAGES_DIR = imageRoot;
globalThis.fetch = async () => { throw new Error('network forbidden in standing tests'); };
const { getDb } = await import('../src/db/index.js');
const service = await import('../src/services/expressionStandingService.js');
const { config } = await import('../src/config.js');
const { getStandingDisplay } = await import('../src/services/standingDisplay.js');
const { STANDING_PREFIX } = await import('../src/services/expressionStandingPipeline.js');
const db = getDb();
const { TOUCH_PARTS, readTouchLines } = await import('../src/services/standingTouchLines.js');
after(() => { db.close(); fs.rmSync(imageRoot, { recursive: true, force: true }); });

function newCharacter() {
  const name = `fixture-${Math.random()}`;
  return Number(db.prepare(`INSERT INTO characters(name,display_name,base_prompt,standing_url) VALUES(?,?,?,'untouched.png')`).run(name, name, 'A girl with brown hair.').lastInsertRowid);
}
test('full set starts one dialogue job alongside rendering; partial retry does not generate dialogue', async () => {
  const id=newCharacter();let release,entered,calls=0;
  const started=new Promise(r=>entered=r);
  const text=new Promise(r=>release=r);
  const {jobId}=service.startStandingBatch(id,{}, {
    touchLinesGenerator:async()=>{calls++;entered();return text;},
    promptGenerator:async(_,slots)=>new Map(slots.map(s=>[s.id,'full body, default standing pose'])),
    imageGenerator:async()=>{assert.equal(readTouchLines(db,id).status,'generating');throw new Error('fixture image failure');},
  });
  await started;
  assert.equal((await waitForJob(jobId)).status,'partial_failed');
  assert.equal(calls,1);assert.equal(readTouchLines(db,id).status,'generating');
  release({lines:Object.fromEntries(Object.keys(TOUCH_PARTS).map(k=>[k,['第一句测试台词','第二句测试台词','第三句测试台词']]))});
  for(let i=0;i<100&&readTouchLines(db,id).status==='generating';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(readTouchLines(db,id).status,'ready');
  const retry=service.startStandingBatch(id,{slotIds:['normal'],reusePrompts:true},{touchLinesGenerator:()=>assert.fail('single image must not call LLM'),imageGenerator:async()=>{throw new Error('fixture');}});
  await waitForJob(retry.jobId);assert.equal(calls,1);
});
async function sourceImage() {
  return sharp({ create: { width: 32, height: 64, channels: 4, background: '#ffffff' } })
    .composite([{ input: await sharp({ create: { width: 12, height: 48, channels: 4, background: '#aa2244' } }).png().toBuffer(), left: 10, top: 8 }]).png().toBuffer();
}
const dataUrl = b => `data:image/png;base64,${b.toString('base64')}`;
test('restart-interrupted jobs expose resume and reuse saved prompts without replacing completed images', async () => {
  const id = newCharacter(); const image = dataUrl(await sourceImage());
  await service.editStandingImage(id, 'normal', 'upload', { image });
  const oldImage = service.listExpressionStandings(id).slots[0].image_url;
  const slot = service.standingSlots()[1].id;
  service.updateStandingPrompt(id, slot, 'saved expression, full body, white background');
  db.prepare("UPDATE character_expression_standings SET status='failed' WHERE character_id=? AND slot_id=?").run(id, slot);
  const jobId = `restart-${id}`;
  db.prepare("INSERT INTO expression_standing_jobs(id,character_id,slots_json,status,completed,error,request_json) VALUES(?,?,?,'failed',1,?,?)").run(jobId, id, JSON.stringify(['normal', slot]), '服务重启导致生成中断，请重试', JSON.stringify({ promptsReady: true, requirement: 'keep clothing' }));
  assert.equal(service.listExpressionStandings(id).jobs[0].resumable, true);
  let count = 0;
  const resumed = service.controlStandingBatch(id, jobId, 'resume', {
    promptGenerator: () => assert.fail('saved prompts must be reused'),
    imageGenerator: async prompt => { count++; assert.match(prompt, /saved expression/); return { success: true, images: [{ base64: image }] }; },
  });
  assert.equal((await waitForJob(resumed.jobId)).status, 'done');
  assert.equal(count, 1);
  assert.equal(service.listExpressionStandings(id).slots[0].image_url, oldImage);
  assert.throws(() => service.controlStandingBatch(id, jobId, 'resume'));
});

test('interrupted prompt stage restores its saved extra requirements', async () => {
  const id = newCharacter(); const image = dataUrl(await sourceImage());
  const jobId = `restart-prompts-${id}`;
  db.prepare("INSERT INTO expression_standing_jobs(id,character_id,slots_json,status,error,request_json) VALUES(?,?,?,'failed',?,?)").run(jobId, id, '["normal"]', '服务重启导致生成中断，请重试', JSON.stringify({ promptsReady: false, requirement: 'gentle poses' }));
  let count = 0;
  const resumed = service.controlStandingBatch(id, jobId, 'resume', {
    promptGenerator: async (_, slots, requirement) => { count++; assert.equal(requirement, 'gentle poses'); return new Map(slots.map(s => [s.id, 'full body, white background'])); },
    imageGenerator: async () => ({ success: true, images: [{ base64: image }] }),
  });
  assert.equal((await waitForJob(resumed.jobId)).status, 'done'); assert.equal(count, 1);
});
async function waitForStatus(jobId, status) {
  for (let i = 0; i < 200; i++) {
    const job = db.prepare('SELECT * FROM expression_standing_jobs WHERE id=?').get(jobId);
    if (job.status === status) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`job did not reach ${status}`);
}

test('stopping finishes current image, releases queue, and resumes remaining slots without repeating prompts', async () => {
  const id = newCharacter(); const slots = service.standingSlots().slice(0, 3);
  const image = dataUrl(await sourceImage());
  let release, entered; const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let prompts = 0, images = 0;
  const { jobId } = service.startStandingBatch(id, { slotIds: slots.map(s => s.id) }, {
    promptGenerator: async () => { prompts++; return new Map(slots.map(s => [s.id, 'same appearance, full body, white background'])); },
    imageGenerator: async () => { images++; if (images === 1) { entered(); await waiting; } return { success: true, images: [{ base64: image }] }; },
  });
  await started;
  service.controlStandingBatch(id, jobId, 'stop');
  release();
  const paused = await waitForStatus(jobId, 'paused');
  assert.equal(paused.completed, 1); assert.equal(images, 1);
  const first = service.listExpressionStandings(id).slots[0].image_url;
  assert.ok(first);
  // A paused character must not hold the global generation queue.
  const otherId = newCharacter();
  const other = service.startStandingBatch(otherId, { slotIds: ['normal'] }, {
    promptGenerator: async () => new Map([['normal', 'full body, white background']]),
    imageGenerator: async () => ({ success: true, images: [{ base64: image }] }),
  });
  assert.equal((await waitForJob(other.jobId)).status, 'done');
  service.controlStandingBatch(id, jobId, 'resume');
  assert.throws(() => service.controlStandingBatch(id, jobId, 'resume'));
  assert.equal((await waitForJob(jobId)).status, 'done');
  assert.equal(prompts, 1); assert.equal(images, 3);
  assert.equal(service.listExpressionStandings(id).slots[0].image_url, first);
});

test('stop during prompt generation saves the full batch but submits zero images until resumed', async () => {
  const id = newCharacter(); const image = dataUrl(await sourceImage());
  let release, entered; const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let prompts = 0, images = 0;
  const { jobId } = service.startStandingBatch(id, { slotIds: ['normal'] }, {
    promptGenerator: async () => { prompts++; entered(); await waiting; return new Map([['normal', 'full body, white background']]); },
    imageGenerator: async () => { images++; return { success: true, images: [{ base64: image }] }; },
  });
  await started; service.controlStandingBatch(id, jobId, 'stop'); release();
  await waitForStatus(jobId, 'paused');
  assert.equal(images, 0);
  assert.ok(service.listExpressionStandings(id).slots[0].prompt);
  service.controlStandingBatch(id, jobId, 'resume'); await waitForJob(jobId);
  assert.equal(prompts, 1); assert.equal(images, 1);
});
async function waitForJob(id) {
  for (let i = 0; i < 200; i++) {
    const job = db.prepare('SELECT * FROM expression_standing_jobs WHERE id=?').get(id);
    if (['done', 'failed', 'partial_failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('standing job timed out');
}

test('real orchestration: one prompt call, persisted barrier, sequential rendering, frozen settings, failed-image retry', async () => {
  const id = newCharacter(); const slots = service.standingSlots().slice(0, 3); const image = dataUrl(await sourceImage());
  let calls = 0, rendering = 0, maxRendering = 0, count = 0;
  const savedArtist = config.comfyui.momentsArtist;
  const { jobId } = service.startStandingBatch(id, { slotIds: slots.map(s => s.id) }, {
    promptGenerator: async (_, targets) => { calls++; config.comfyui.momentsArtist = 'changed during batch'; return new Map(targets.map(s => [s.id, 'full body, white background, same character and clothing'])); },
    imageGenerator: async (_, opts) => {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_expression_standings WHERE character_id=? AND prompt != ?').get(id, '').n, 3);
      assert.equal(opts.artist, savedArtist);
      maxRendering = Math.max(maxRendering, ++rendering); count++;
      await new Promise(resolve => setTimeout(resolve, 5)); rendering--;
      if (count === 2) throw new Error('fixture generation failure');
      return { success: true, images: [{ base64: image }] };
    },
  });
  assert.throws(() => service.startStandingBatch(id, {}), /正在进行/);
  const job = await waitForJob(jobId); config.comfyui.momentsArtist = savedArtist;
  assert.equal(calls, 1); assert.equal(maxRendering, 1); assert.equal(job.status, 'partial_failed'); assert.equal(job.completed, 3);
  let rows = service.listExpressionStandings(id).slots;
  assert.ok(rows[0].image_url); assert.equal(rows[1].status, 'failed'); assert.ok(rows[2].image_url);
  const retry = service.startStandingBatch(id, { slotIds: [slots[1].id], reusePrompts: true }, {
    promptGenerator: () => { throw new Error('must reuse saved prompts'); },
    imageGenerator: async () => ({ success: true, images: [{ base64: image }] }),
  });
  assert.equal((await waitForJob(retry.jobId)).status, 'done');
  rows = service.listExpressionStandings(id).slots; assert.ok(rows[1].image_url);
  assert.equal(db.prepare('SELECT standing_url FROM characters WHERE id=?').get(id).standing_url, 'untouched.png');
});

test('upload removes outside white, computes bounds; saved alpha and crop preserved; failed regeneration retains old image', async () => {
  const id = newCharacter();
  await service.editStandingImage(id, 'normal', 'upload', { image: dataUrl(await sourceImage()) });
  const first = service.listExpressionStandings(id).slots[0];
  assert.deepEqual(first.bounds, { x: 10, y: 8, width: 12, height: 48, imageWidth: 32, imageHeight: 64 });
  assert.ok(fs.existsSync(path.join(imageRoot, 'expression_standing', path.basename(first.source_url))));
  const transparent = await sharp({ create: { width: 20, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: .5 } } }).png().toBuffer();
  await service.editStandingImage(id, 'normal', 'image', { image: dataUrl(transparent) });
  let row = service.listExpressionStandings(id).slots[0];
  const alpha = await sharp(path.join(imageRoot, 'expression_standing', path.basename(row.image_url))).stats();
  assert.ok(alpha.channels[3].min > 0 && alpha.channels[3].max < 255);
  await service.editStandingImage(id, 'normal', 'crop', { x: 2, y: 3, w: 10, h: 20 });
  row = service.listExpressionStandings(id).slots[0];
  assert.equal(row.bounds.imageWidth, 10); assert.equal(row.bounds.imageHeight, 20);
  const oldUrl = row.image_url;
  service.updateStandingPrompt(id, 'normal', 'full body, white background, female character');
  const { jobId } = service.startStandingBatch(id, { slotIds: ['normal'], reusePrompts: true }, { imageGenerator: async () => { throw new Error('image failed'); } });
  await waitForJob(jobId);
  assert.equal(service.listExpressionStandings(id).slots[0].image_url, oldUrl);
  getStandingDisplay().select(id);
  assert.equal(getStandingDisplay().snapshot().imageUrl, oldUrl);
  service.deleteStanding(id, 'normal');
  assert.equal(getStandingDisplay().snapshot().imageUrl, null);
});

test('prompt stage failure submits no images and preserves old prompt/image', async () => {
  const id = newCharacter(); let images = 0;
  service.updateStandingPrompt(id, 'normal', 'previous valid illustration prompt');
  const { jobId } = service.startStandingBatch(id, { slotIds: ['normal'] }, {
    promptGenerator: () => { throw new Error('invalid JSON'); }, imageGenerator: () => { images++; },
  });
  assert.equal((await waitForJob(jobId)).status, 'failed'); assert.equal(images, 0);
  assert.equal(service.listExpressionStandings(id).slots[0].prompt, 'previous valid illustration prompt');
});

test('every prompt handed to ComfyUI starts with solo, whether generated or reused', async () => {
  const id = newCharacter(); const image = dataUrl(await sourceImage()); const seen = [];
  const { jobId } = service.startStandingBatch(id, { slotIds: ['normal'] }, {
    promptGenerator: async (_, targets) => new Map(targets.map(s => [s.id, '1girl, brown hair, white dress'])),
    imageGenerator: async prompt => { seen.push(prompt); return { success: true, images: [{ base64: image }] }; },
  });
  assert.equal((await waitForJob(jobId)).status, 'done');
  assert.equal(seen[0], `${STANDING_PREFIX}, 1girl, brown hair, white dress`);
  // 用户手改后复用已存提示词：同一个前置阀门，不重复补标签
  service.updateStandingPrompt(id, 'normal', '1girl, brown hair, changed dress');
  const retry = service.startStandingBatch(id, { slotIds: ['normal'], reusePrompts: true }, {
    promptGenerator: () => { throw new Error('must reuse saved prompts'); },
    imageGenerator: async prompt => { seen.push(prompt); return { success: true, images: [{ base64: image }] }; },
  });
  assert.equal((await waitForJob(retry.jobId)).status, 'done');
  assert.equal(seen[1], `${STANDING_PREFIX}, 1girl, brown hair, changed dress`);
});
