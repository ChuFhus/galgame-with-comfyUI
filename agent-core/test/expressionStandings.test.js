import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateExpressionStandings, recoverExpressionStandingJobs } from '../src/db/expressionStandingSchema.js';
import { parseStandingPrompts, runStandingBatch } from '../src/services/expressionStandingPipeline.js';
import { createStandingDisplay } from '../src/services/standingDisplayState.js';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('network forbidden in standing tests'); };
const { saveEmojiCategories, parseEmojiText } = await import('../src/services/emojiService.js');

const slots = [{ id: 'normal' }, { id: 'emoji:7' }];
const json = JSON.stringify({ prompts: slots.map(s => ({ slotId: s.id, prompt: 'A full body character with a gentle smile and matching costume.' })) });

test('batch prompts are generated once and saved as a barrier before serial images; failure continues', async () => {
  const order = [];
  await runStandingBatch({ slots,
    generatePrompts: async () => { order.push('prompts'); return parseStandingPrompts(json, slots); },
    savePrompts: async p => { assert.equal(p.size, 2); order.push('save'); },
    render: async s => { order.push(s.id); if (s.id === 'normal') throw new Error('render failed'); },
    failed: async s => order.push(`failed:${s.id}`), complete: async s => order.push(`complete:${s.id}`),
  });
  assert.deepEqual(order, ['prompts', 'save', 'normal', 'failed:normal', 'complete:normal', 'emoji:7', 'complete:emoji:7']);
});
test('invalid, missing, duplicate, foreign and non-English prompts never render', async () => {
  const bad = ['{}', '{', JSON.stringify({ prompts: [{ slotId: 'normal', prompt: 'long enough prompt' }] }),
    JSON.stringify({ prompts: [{ slotId: 'normal', prompt: 'long enough prompt' }, { slotId: 'normal', prompt: 'duplicate prompt' }] }),
    JSON.stringify({ prompts: [{ slotId: 'other', prompt: 'long enough prompt' }, { slotId: 'normal', prompt: 'long enough prompt' }] }),
    json.replace('A full body', '中文 A full body')];
  for (const raw of bad) {
    let images = 0, saves = 0;
    await assert.rejects(runStandingBatch({ slots, generatePrompts: () => parseStandingPrompts(raw, slots), savePrompts: () => saves++, render: () => images++, failed: () => {}, complete: () => {} }));
    assert.equal(images, 0); assert.equal(saves, 0);
  }
});
test('database save failure never submits images', async () => {
  let images = 0;
  await assert.rejects(runStandingBatch({ slots, generatePrompts: () => parseStandingPrompts(json, slots), savePrompts: () => { throw new Error('DB'); }, render: () => images++ }));
  assert.equal(images, 0);
});
function fixture() {
  let clock = 100;
  const events = [];
  const display = createStandingDisplay({ now: () => clock, emit: s => events.push(s), resolveImage: (id, slot) => ({ image_url: `${id}/${slot === 'emoji:missing' ? 'normal' : slot}` }) });
  display.select(1);
  return { display, events, advance: n => { clock += n; } };
}
test('triggering round is excluded; two subsequent complete replies reset; duplicate completion ignored', () => {
  const { display: d } = fixture();
  const a = d.begin(1, 'a'); d.expression(a, 'emoji:7'); d.complete(a);
  assert.equal(d.snapshot().quietTurns, 0);
  const b = d.begin(1, 'b'); d.complete(b); d.complete(b);
  assert.equal(d.snapshot().slotId, 'emoji:7'); assert.equal(d.snapshot().quietTurns, 1);
  const c = d.begin(1, 'c'); d.complete(c);
  assert.equal(d.snapshot().slotId, 'normal');
});
test('same expression resets count; cancelled and foreign-character replies do not count', () => {
  const { display: d } = fixture();
  let t = d.begin(1, 'a'); d.expression(t, 'emoji:7'); d.complete(t);
  t = d.begin(1, 'b'); d.complete(t);
  t = d.begin(1, 'c'); d.expression(t, 'emoji:7'); d.complete(t);
  d.begin(1, 'cancelled'); d.complete(d.begin(2, 'foreign'));
  assert.equal(d.snapshot().quietTurns, 0); assert.equal(d.snapshot().slotId, 'emoji:7');
});
test('A → B → A rejects old expression/reason; same-client stale selection rejected', () => {
  const { display: d } = fixture();
  const stale = d.begin(1, 'old');
  d.select(2, 'device', 3); d.select(1, 'device', 2);
  assert.equal(d.snapshot().characterId, 2);
  d.select(1, 'device', 4); d.expression(stale, 'emoji:7'); d.reason(stale, 'stale'); d.complete(stale);
  assert.equal(d.snapshot().slotId, 'normal'); assert.equal(d.snapshot().reason, null);
});
test('reason persists until replacement or selection; missing expression falls back normally', () => {
  const { display: d, advance } = fixture();
  const t = d.begin(1, 'a'); d.expression(t, 'emoji:missing'); d.complete(t); d.reason(t, '开心');
  assert.equal(d.snapshot().imageUrl, '1/normal'); assert.equal(d.snapshot().reason.createdAt, 100);
  advance(60001); assert.equal(d.snapshot().reason.text, '开心');
  const next = d.begin(1, 'b'); d.complete(next); assert.equal(d.snapshot().reason.text, '开心');
  d.reason(next, '新的想法'); assert.equal(d.snapshot().reason.text, '新的想法');
  d.select(2); assert.equal(d.snapshot().reason, null);
});
test('schema isolated from ordinary standings; category renames and swaps preserve slot IDs and stickers', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  try {
    db.exec(`CREATE TABLE characters(id INTEGER PRIMARY KEY, standing_url TEXT); INSERT INTO characters VALUES(1,'original.png');
      CREATE TABLE emoji_categories(id INTEGER PRIMARY KEY,emoji_key TEXT UNIQUE,sort_order INTEGER);
      CREATE TABLE character_emojis(set_id INTEGER,emoji_key TEXT,UNIQUE(set_id,emoji_key));`);
    const keys = Array.from({ length: 15 }, (_, i) => `表情${i}`);
    keys.forEach((k, i) => { db.prepare('INSERT INTO emoji_categories VALUES(?,?,?)').run(i + 1, k, i); db.prepare('INSERT INTO character_emojis VALUES(1,?)').run(k); });
    migrateExpressionStandings(db); migrateExpressionStandings(db);
    db.prepare(`INSERT INTO character_expression_standings(character_id,slot_id,image_url) VALUES(1,'emoji:1','independent.png')`).run();
    const renamed = [...keys]; [renamed[0], renamed[1]] = [renamed[1], renamed[0]];
    saveEmojiCategories(renamed, db);
    assert.equal(db.prepare('SELECT emoji_key FROM emoji_categories WHERE id=1').get().emoji_key, keys[1]);
    assert.equal(db.prepare('SELECT image_url FROM character_expression_standings').get().image_url, 'independent.png');
    assert.equal(db.prepare('SELECT standing_url FROM characters').get().standing_url, 'original.png');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_emojis').get().n, 15);
    db.prepare('DELETE FROM characters WHERE id=1').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_expression_standings').get().n, 0);
  } finally { db.close(); }
});
test('emoji parser preserves actual sent semantic labels and ignores unknown tags', () => {
  const parsed = parseEmojiText('[开心]你好【未知】【开心】', new Map([['开心', '/emoji.png']]));
  assert.deepEqual(parsed.keys, ['开心', '开心']); assert.deepEqual(parsed.images, ['/emoji.png']); assert.equal(parsed.content, '你好');
});

test('restart marks unfinished jobs retryable and retains both old images and saved prompts', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE characters(id INTEGER PRIMARY KEY); INSERT INTO characters VALUES(1)');
    migrateExpressionStandings(db);
    db.exec(`INSERT INTO character_expression_standings(character_id,slot_id,prompt,image_url,status) VALUES(1,'normal','saved prompt','old.png','generating');
      INSERT INTO expression_standing_jobs(id,character_id,slots_json,status) VALUES('job',1,'["normal"]','generating');`);
    recoverExpressionStandingJobs(db);
    const row = db.prepare('SELECT * FROM character_expression_standings').get();
    assert.equal(row.status, 'failed'); assert.equal(row.prompt, 'saved prompt'); assert.equal(row.image_url, 'old.png');
    assert.equal(db.prepare('SELECT status FROM expression_standing_jobs').get().status, 'failed');
  } finally { db.close(); }
});
