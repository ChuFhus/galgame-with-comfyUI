import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`teleport fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
// 重新布局归位测试不发模型与生图请求
config.llm.baseURL = 'http://127.0.0.1:9/v1';
config.llm.apiKey = 'teleport-origin-test';
const { resetClient } = await import('../src/llm/llm-client.js');
resetClient();
const { getDb, closeDb } = await import('../src/db/index.js');
const town = await import('../src/services/town/townService.js');
const { saveMap } = await import('../src/services/town/townMapService.js');
const init = await import('../src/services/town/townInitService.js');

// 管理面板放大/缩小地图重新布局后，本图人物（居民 + 玩家）一律先归位回 (0,0)：
// 旧坐标在新图上可能越界或被新建筑压住，原点是统一的重出发点。

test('重新布局后人物归位回 (0,0)', async t => {
  config.features.town = true; config.features.townLLM = false;
  Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false,
    playerSpeed: 1, npcSpeed: 1, maxActiveEncounters: 0, timeZone: 'Asia/Shanghai',
    aiLayoutOptimize: false, mapSize: 30 });

  const db = getDb();
  const insert = db.prepare(`INSERT INTO town_assets (kind, key, name, image_path, meta_json, world_setting_id, status)
    VALUES (?, ?, ?, '/town-assets/test.png', ?, NULL, 'ready')`);
  const seed = (kind, key, name, footprint) => Number(insert.run(kind, key, name,
    JSON.stringify(footprint ? { desc: name, footprint } : { desc: name })).lastInsertRowid);
  const groundA = seed('ground', 'grass_a', '草地A');
  const groundB = seed('ground', 'grass_b', '草地B');
  const road = seed('road', 'stone_road', '石板路');
  const inn = seed('building', 'inn', '旅店', { w: 3, h: 2 });
  const oak = seed('prop', 'oak', '橡树');

  const COLS = 30, ROWS = 30;
  const ground = Array.from({ length: ROWS }, () => Array(COLS).fill(groundA));
  for (let y = 0; y < 6; y++) for (let x = 0; x < COLS; x++) ground[y][x] = groundB;
  const roadLayer = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  for (let x = 0; x < COLS; x++) roadLayer[15][x] = road;
  const before = saveMap({ create: true, name: '老镇', cols: COLS, rows: ROWS,
    layers: { ground, road: roadLayer, objects: [
      { id: 1, assetId: inn, x: 10, y: 10, flip: false },
      { id: 2, assetId: oak, x: 20, y: 20, flip: false },
    ] },
    locations: [{ key: 'plaza', name: '广场', x: 15, y: 15, radius: 3 }] });

  // 重新布局前人物散在老图各处：玩家 (25,25)，居民 (5,26)
  db.prepare("INSERT INTO town_players (id, display_name, grid_x, grid_y, map_id) VALUES ('me', '玩家', 25, 25, ?)")
    .run(before.mapId);
  db.prepare(`INSERT INTO town_agent_state (agent_key, map_id, grid_x, grid_y) VALUES ('me', ?, 25, 25)`)
    .run(before.mapId);
  const npcId = Number(db.prepare("INSERT INTO town_npcs (map_id, display_name, persona, town_enabled) VALUES (?, '阿婆', '', 1)").run(before.mapId).lastInsertRowid);
  db.prepare(`INSERT INTO town_agent_state (agent_key, map_id, grid_x, grid_y) VALUES (?, ?, 5, 26)`)
    .run(`npc:${npcId}`, before.mapId);

  town.startTownScheduler();
  town.touchTownViewer();
  t.after(() => { town.stopTownScheduler(); closeDb(); });

  const beforeState = town.getTownState(before.mapId);
  assert.equal(beforeState.player.x, 25);
  assert.equal(beforeState.player.y, 25);

  const result = await init.relayoutWorld();
  assert.equal(result.ok, true, `重新布局应当成功：${result.error || ''}`);
  assert.equal(result.mapId, before.mapId);

  // 与路由同口径：saveMap 后同步 reloadMap（落盘传送结果 → 重建），中间没有模拟拍能插进来
  town.reloadMap(result.mapId);

  const rows = db.prepare('SELECT agent_key, grid_x, grid_y FROM town_agent_state WHERE map_id = ?').all(before.mapId);
  assert.ok(rows.length >= 2, `玩家与居民的快照都应落库（实际 ${rows.length} 条）`);
  for (const row of rows) {
    assert.equal(row.grid_x, 0, `${row.agent_key} 应归位到 x=0`);
    assert.equal(row.grid_y, 0, `${row.agent_key} 应归位到 y=0`);
  }

  const st = town.getTownState(before.mapId);
  assert.equal(st.player.x, 0, '玩家重建后应站在 (0,0)');
  assert.equal(st.player.y, 0, '玩家重建后应站在 (0,0)');
});
