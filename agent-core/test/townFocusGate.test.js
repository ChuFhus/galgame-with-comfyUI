import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`focus gate fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const town = await import('../src/services/town/townService.js');
const { createNpc } = await import('../src/services/town/townNpcService.js');
const { saveMap } = await import('../src/services/town/townMapService.js');

/**
 * 聚焦闸门 = 「玩家在这张图上」×「小镇页面在线」。
 * M0 起「世界逻辑」与「演出」分离：相遇扫描/规则结算属于世界逻辑，后台图照常发生；
 * 相遇对话、摘要润色、环境奇遇升级、批量状态气泡是演出，仍全在聚焦闸门之后。
 * 这里用**同一批居民、同一套触发规则**，只翻转玩家所在地图：后台图允许相遇但不产生
 * 任何演出与模型调用（fetch 被禁兜底），聚焦图立刻照常开演。
 * （townLLM 关闭是为了测试不碰模型；演出闸门在 LLM 检查之前，验的是同一道门。）
 */
test('聚焦闸门：后台图有相遇无演出，聚焦图照常开演', async t => {
  let now = Date.parse('2026-09-08T10:00:00+08:00');
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  config.dbPath = ':memory:';
  config.features.town = true; config.features.townLLM = false;
  const db = getDb();
  // 注意顺序：getDb 会用库里存的设置覆盖 config，测试口径必须在 getDb 之后再定
  Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
    maxActiveEncounters: 1, encounterStrangerProb: 1, encounterRelatedProb: 1,
    encounterMinStartGapMin: 0, encounterCooldownHours: 0, timeZone: 'Asia/Shanghai' });
  t.after(() => { town.stopTownScheduler(); closeDb(); t.mock.restoreAll(); t.mock.timers.reset(); });

  const grid = () => Array.from({ length: 8 }, () => Array(8).fill(null));
  // 老镇：玩家在这里，只有一位居民，构不成相遇
  const { mapId: mapA } = saveMap({ create: true, name: '老镇', cols: 8, rows: 8,
    layers: { ground: grid(), road: grid(), objects: [] },
    locations: [{ key: 'plaza', name: '中央广场', x: 0, y: 0, radius: 3 },
      { key: 'tea', name: '老茶馆', x: 6, y: 6, radius: 1 }] });
  // 海边的镇：两位居民钉在同一个广场（图里只有这一个地点，游走没有别的去处）
  const { mapId: mapB } = saveMap({ create: true, name: '海边的镇', cols: 8, rows: 8,
    layers: { ground: grid(), road: grid(), objects: [] },
    locations: [{ key: 'plaza', name: '渡口广场', x: 0, y: 0, radius: 3 }] });

  createNpc({ mapId: mapA, displayName: '独居的老张', job: '看店的',
    routine: [{ start: '00:00', end: '24:00', locationKey: 'plaza', activity: '看店' }] });
  const loneId = db.prepare('SELECT max(id) id FROM town_npcs').get().id;
  db.prepare(`INSERT INTO town_agent_state(agent_key,map_id,grid_x,grid_y,current_location_id)
    VALUES(?,?,0,0,(SELECT id FROM town_locations WHERE key = 'plaza' AND map_id = ?))`).run(`npc:${loneId}`, mapA, mapA);
  for (const [displayName, x] of [['渡口老板娘', 0], ['修船的小伙', 1]]) {
    createNpc({ mapId: mapB, displayName, job: '居民',
      routine: [{ start: '00:00', end: '24:00', locationKey: 'plaza', activity: '固定岗位' }] });
    const id = db.prepare('SELECT max(id) id FROM town_npcs').get().id;
    db.prepare(`INSERT INTO town_agent_state(agent_key,map_id,grid_x,grid_y,current_location_id)
      VALUES(?,?,?,0,(SELECT id FROM town_locations WHERE key = 'plaza' AND map_id = ?))`).run(`npc:${id}`, mapB, x, mapB);
  }
  db.prepare("INSERT INTO town_players (id, display_name, grid_x, grid_y, map_id) VALUES ('me', '玩家', 0, 1, ?)")
    .run(mapA);

  town.startTownScheduler();
  // 页面在线：前端 15s 一次心跳（服务端 TTL 45s），这里每拍补一次。
  // setImmediate 清空 enqueueLlm 微任务链（相遇对话/收尾时长在其中设定）
  const tickWithViewer = async (ms = 30_000) => {
    now += ms; town.touchTownViewer(); town.forceTick();
    await new Promise(resolve => setImmediate(resolve));
  };

  // ── 阶段一：玩家在老镇，海边的镇是后台图 ──
  town.touchTownViewer();
  assert.equal(town.isMapFocused(mapA), true);
  assert.equal(town.isMapFocused(mapB), false);
  let backgroundEncounter = false;
  for (let i = 0; i < 10 && !backgroundEncounter; i++) {
    await tickWithViewer();
    backgroundEncounter = town.getTownState(mapB).encountersActive.length > 0;
  }
  assert.equal(backgroundEncounter, true, '相遇扫描是世界逻辑：后台图同样会开相遇');
  assert.equal(town.getTownState(mapB).agents.every(a => a.bubble === null), true, '后台图不发状态气泡');

  // 等相遇收尾：零模型按规则结算（模板摘要 + 经历入账），无任何演出与模型调用。
  // encounterCooldownHours=0 时相遇会循环重开，所以按第一场相遇的事件断言。
  for (let i = 0; i < 4; i++) await tickWithViewer(30_000);
  const firstEnc = db.prepare(`SELECT id, status, summary, outcome_json FROM town_encounters WHERE map_id = ? ORDER BY id LIMIT 1`).get(mapB);
  assert.equal(firstEnc.status, 'done', '后台图相遇照常收尾');
  assert.equal(JSON.parse(firstEnc.outcome_json).resultCode, 'silent_pass', '零模型相遇结算为照面');
  assert.ok(firstEnc.summary.includes('碰了个面'), '模板摘要应已落库');
  assert.equal(db.prepare('SELECT count(*) n FROM town_experiences WHERE event_id = ?').get(`encounter:${firstEnc.id}`).n, 2,
    '规则结算沉淀双方经历');

  // ── 阶段二：玩家出行到海边的镇，同一批居民、同一套规则，聚焦图照常开演 ──
  const travel = town.travelPlayer({ targetMapId: mapB });
  assert.equal(travel.ok, true);
  assert.equal(town.isMapFocused(mapB), true);
  assert.equal(town.isMapFocused(mapA), false);
  let focusedEncounter = false;
  for (let i = 0; i < 6 && !focusedEncounter; i++) {
    await tickWithViewer();
    focusedEncounter = town.getTownState(mapB).encountersActive.length > 0;
  }
  assert.equal(focusedEncounter, true, '聚焦图第一拍起照常相遇');
  assert.equal(town.getTownState(mapA).encountersActive.length, 0, '老镇只有一位居民，降级为后台图也不会开相遇');

  // ── 阶段三：页面关掉（心跳过期）后，任何图都不再是聚焦图 ──
  now += 46_000;
  assert.equal(town.isMapFocused(mapB), false, '没人看页面时不该再为任何一张图花钱');
  assert.equal(town.isMapFocused(mapA), false);
  town.touchTownViewer();
  assert.equal(town.isMapFocused(mapB), true, '页面回来自动恢复聚焦');
});
