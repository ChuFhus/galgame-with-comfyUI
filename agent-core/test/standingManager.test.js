import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('network forbidden in standing manager tests'); };
const { getDb } = await import('../src/db/index.js');
const { listStandingOverview, startAllStandingBatches, standingSlots } = await import('../src/services/expressionStandingService.js');
const db = getDb();
afterEach(() => db.prepare('DELETE FROM characters').run());
after(() => db.close());

function addCharacter(name) {
  return Number(db.prepare('INSERT INTO characters(name,display_name,base_prompt) VALUES(?,?,?)').run(name, name, 'A girl with brown hair.').lastInsertRowid);
}
function saveImage(id, slot) {
  db.prepare("INSERT INTO character_expression_standings(character_id,slot_id,image_url,prompt,status) VALUES(?,?,?,'previous prompt','done')").run(id, slot, `/images/fixture-${id}-${slot}.png`);
}
const dependencies = calls => ({
  promptGenerator: async (character, slots, requirement) => {
    calls.push({ id: character.id, slots: slots.map(s => s.id), requirement });
    return new Map(slots.map(s => [s.id, 'full body, new illustration prompt']));
  },
  imageGenerator: async () => { throw new Error('fixture: no real image generation'); },
  touchLinesGenerator: async () => { throw new Error('fixture: no real dialogue generation'); },
});
async function waitForJobs(result) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (result.started.every(({ jobId }) => ['done', 'failed', 'partial_failed'].includes(db.prepare('SELECT status FROM expression_standing_jobs WHERE id=?').get(jobId).status))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('batch jobs did not finish');
}

test('overview includes empty characters and counts only current slots', () => {
  const empty = addCharacter('empty'), partial = addCharacter('partial');
  saveImage(partial, 'normal'); saveImage(partial, 'emoji:obsolete');
  const rows = listStandingOverview();
  assert.equal(rows.find(r => r.id === empty).count, 0);
  assert.equal(rows.find(r => r.id === partial).count, 1);
  assert.equal(rows.find(r => r.id === partial).total, standingSlots().length);
  assert.ok(!rows.find(r => r.id === partial).missingSlotIds.includes('normal'));
});

test('regenerate all rebuilds every prompt with the same direction and skips running jobs', async () => {
  const first = addCharacter('first'), second = addCharacter('second');
  saveImage(first, 'normal');
  const calls = [];
  const result = startAllStandingBatches({ mode: 'all', requirement: '  winter clothes  ' }, dependencies(calls));
  assert.deepEqual(result.started.map(r => r.characterId), [first, second]);
  const repeated = startAllStandingBatches({ mode: 'all' }, dependencies(calls));
  assert.deepEqual(repeated.skippedBusy, [first, second]);
  assert.equal(repeated.started.length, 0);
  await waitForJobs(result);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.requirement, 'winter clothes');
    assert.deepEqual(call.slots, standingSlots().map(s => s.id));
  }
  assert.equal(db.prepare("SELECT prompt FROM character_expression_standings WHERE character_id=? AND slot_id='normal'").get(first).prompt, 'full body, new illustration prompt');
});

test('fill missing leaves existing images and prompts untouched and skips complete characters', async () => {
  const partial = addCharacter('partial'), complete = addCharacter('complete');
  saveImage(partial, 'normal');
  for (const slot of standingSlots()) saveImage(complete, slot.id);
  const before = db.prepare("SELECT * FROM character_expression_standings WHERE character_id=? AND slot_id='normal'").get(partial);
  const calls = [];
  const result = startAllStandingBatches({ mode: 'missing', requirement: 'gentle poses' }, dependencies(calls));
  assert.deepEqual(result.skippedComplete, [complete]);
  await waitForJobs(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requirement, 'gentle poses');
  assert.deepEqual(calls[0].slots, standingSlots().filter(s => s.id !== 'normal').map(s => s.id));
  assert.deepEqual(db.prepare("SELECT * FROM character_expression_standings WHERE character_id=? AND slot_id='normal'").get(partial), before);
});

test('invalid batch mode fails without starting work; an empty tavern is a no-op', () => {
  assert.throws(() => startAllStandingBatches({ mode: 'invalid' }), /请选择/);
  assert.equal(startAllStandingBatches({ mode: 'missing' }).started.length, 0);
});
