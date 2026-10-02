import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw Error('carry fixture forbids generation/network'); };
const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const town = await import('../src/services/town/townService.js');
const { saveMap } = await import('../src/services/town/townMapService.js');
const { default: routes } = await import('../src/routes/town.js');

test('real runtime and API: carry holds through ticks, drops persist, restores routine, rejects stale worlds/maps', async t => {
  let now = Date.parse('2026-10-03T12:00:00+08:00');
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const db = getDb();
  config.features.town = true; config.features.townLLM = false;
  Object.assign(config.town, { economyEnabled: false, maxActiveEncounters: 0, timeZone: 'Asia/Shanghai' });
  const grid = () => Array.from({ length: 8 }, () => Array(8).fill(null));
  const { mapId } = saveMap({ name: '拎起测试镇', cols: 8, rows: 8,
    layers: { ground: grid(), road: grid(), objects: [] },
    locations: [{ key: 'plaza', name: '广场', x: 1, y: 1, radius: 0 },
      { key: 'cafe', name: '咖啡馆', x: 6, y: 6, radius: 0 }] });
  const npcId = Number(db.prepare(`INSERT INTO town_npcs (map_id,display_name,persona,town_enabled,routine_json)
    VALUES (?, '拎起测试居民', '', 1, ?)`)
    .run(mapId, JSON.stringify([{ start: '00:00', end: '24:00', locationKey: 'cafe', activity: '看风景' }])).lastInsertRowid);
  db.prepare('INSERT INTO town_agent_state (agent_key,map_id,grid_x,grid_y) VALUES (?, ?, 1, 1)').run(`npc:${npcId}`, mapId);
  town.startTownScheduler();
  t.after(() => { town.stopTownScheduler(); closeDb(); });
  const snap = town.getTownState();
  const actor = snap.agents.find(a => a.npcId === npcId || a.agentKey === `npc:${npcId}`);
  assert.ok(actor?.actorId);
  const app = express(); app.use(express.json()); app.use('/town', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const post = body => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/town/actors/${actor.actorId}/carry`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk });
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  const scope = { worldId: snap.worldId, worldEpoch: snap.worldEpoch, mapId, token: 'runtime-carry-0001' };
  assert.equal((await post({ ...scope, mapId: mapId + 100, operation: 'begin' })).status, 409);
  assert.equal((await post({ ...scope, worldEpoch: snap.worldEpoch + 1, operation: 'begin' })).status, 409);
  assert.equal((await post({ token: scope.token, operation: 'begin' })).status, 400);
  const begun = await post({ ...scope, operation: 'begin' });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const resident = () => town.getTownState().agents.find(a => a.actorId === actor.actorId);
  now += 5000; town.forceTick();
  assert.deepEqual([resident().x, resident().y, resident().path.length], [begun.position.x, begun.position.y, 0]);
  assert.equal(town.holdTownActor(actor.actorId).ok, false);
  const dropped = await post({ ...scope, operation: 'drop', x: 3, y: 4 });
  assert.equal(dropped.ok, true); assert.equal(dropped.returned, false, JSON.stringify(dropped));
  assert.deepEqual([resident().x, resident().y], [3, 4]);
  const saved = db.prepare('SELECT grid_x,grid_y FROM town_agent_state WHERE agent_key=? AND map_id=?').get(actor.agentKey, mapId);
  assert.deepEqual(saved, { grid_x: 3, grid_y: 4 });
  assert.equal((await post({ ...scope, operation: 'drop', x: 5, y: 5 })).status, 409);
  let moving = false;
  for (let i = 0; i < 18; i++) { now += 5000; town.forceTick(); moving ||= resident().path.length > 0; }
  assert.equal(moving, true, 'routine starts walking again after release');
});
