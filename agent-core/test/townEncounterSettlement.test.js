import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`settlement fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
// 注意顺序：getDb 会用库里存的设置覆盖 config，测试口径必须在 getDb 之后再定。
// 零模型口径：townLLM / townAutoLLM 全关，fetch 被禁——任何隐式模型请求都会立刻抛错。
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
  maxActiveEncounters: 1, encounterStrangerProb: 1, encounterRelatedProb: 1,
  encounterMinStartGapMin: 0, timeZone: 'Asia/Shanghai' });
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');
const { createTownEventService } = await import('../src/services/town/townEventService.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');

/** LLM 串行队列是微任务链：同步测试里用 setImmediate 清空它 */
const flushLlm = () => new Promise(resolve => setImmediate(resolve));

// 同一进程共享内存库与 townService 单例，两个验收场景放在一个测试里按阶段执行
test('M0 验收：零模型相遇闭环 + 重复消费幂等 + 重启保守恢复', async t => {
  let now = Date.parse('2026-09-30T09:00:00+08:00');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sim = createTownHeadlessSim({ startUtcMs: now });
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });
  // Date.now 跟随虚拟时钟：runEncounterDialogue 的 endAt、观看 TTL 等内部读取保持一致
  t.mock.method(Date, 'now', () => sim.now);
  const db = getDb();

  // ── 阶段一：零模型相遇闭环（后台图相遇 → 规则结算 → 经历入账）──
  // 相遇扫描已与演出解耦：没有观看者（后台图）也会开相遇
  let encounterId = null;
  for (let i = 0; i < 6 && !encounterId; i++) {
    sim.step(30_000);
    await flushLlm();
    const rows = db.prepare('SELECT id FROM town_encounters WHERE map_id = ?').all(sim.mapId);
    if (rows.length) encounterId = rows[0].id;
  }
  assert.ok(encounterId, '后台图也应在几拍内开相遇（世界逻辑与演出分离）');

  // 推进到收尾：零模型相遇 45s 自然结束 → 规则结算
  for (let i = 0; i < 4; i++) { sim.step(30_000); await flushLlm(); }
  const row = db.prepare('SELECT * FROM town_encounters WHERE id = ?').get(encounterId);
  assert.equal(row.status, 'done', '相遇应收尾');
  const outcome = JSON.parse(row.outcome_json);
  assert.equal(outcome.resultCode, 'silent_pass', '零模型相遇没有对话 → 照面');
  assert.equal(outcome.interactionType, 'pass_by');
  assert.ok(outcome.ruleVersion >= 1, '结构化结果必须带规则版本');
  assert.equal(row.summary, '看店的阿圆和散步的小林在中央广场碰了个面，简单打了个照面。');
  assert.equal(row.polished_summary, '', '零模型下不应有润色文本');

  // 规则结算产生可追溯的领域事件（世界/地图/参与人/来源齐全）
  const eventRow = db.prepare('SELECT envelope FROM town_domain_events WHERE event_id = ?').get(`encounter:${encounterId}`);
  assert.ok(eventRow, '规则结算应产生 town.encounter.happened 事件');
  const envelope = JSON.parse(eventRow.envelope);
  assert.equal(envelope.type, 'town.encounter.happened');
  assert.equal(envelope.actorIds.length, 2);
  assert.equal(envelope.payload.resultCode, 'silent_pass');

  // 经历入账：下一拍 drain，双方各一条；文本由注册表人名 + 结果代码短语组装
  sim.step(30_000);
  const countByEvent = eventId =>
    db.prepare('SELECT count(*) n FROM town_experiences WHERE event_id = ?').get(eventId).n;
  assert.equal(countByEvent(`encounter:${encounterId}`), 2, '双方都应沉淀一条共同经历');
  const exp = db.prepare('SELECT summary FROM town_experiences WHERE event_id = ? LIMIT 1').get(`encounter:${encounterId}`);
  assert.equal(exp.summary, '看店的阿圆和散步的小林在中央广场碰了个面，打了个照面。');

  // 重复消费同一事件：经历条数不变（幂等）
  sim.step(30_000);
  sim.step(30_000);
  assert.equal(countByEvent(`encounter:${encounterId}`), 2, '重复 drain 不得新增经历');

  // ── 阶段二：保守恢复（重启收尾中断相遇；历史相遇旧文本不被改写、不重复结算）──
  // 停掉扫描，只搭图与居民，避免真实相遇干扰恢复断言
  config.town.maxActiveEncounters = 0;
  sim.stop(); // 制造「进程停在中途」的状态

  const registry = createTownActorRegistry(db);
  const world = registry.getWorldState();
  const scope = { worldId: world.worldId, worldEpoch: world.epoch };
  const actors = sim.npcIds.map(id => registry.resolveAgentKey(`npc:${id}`).actorId);

  // 中断相遇 A：没有任何经历事件 → 重启后应补一次规则结算
  const encA = db.prepare(`INSERT INTO town_encounters (map_id, char_a, char_b, location_id, status)
    VALUES (?, ?, ?, (SELECT id FROM town_locations WHERE map_id = ? AND key = 'plaza'), 'chatting')`)
    .run(sim.mapId, -sim.npcIds[0], -sim.npcIds[1], sim.mapId);
  const encAId = Number(encA.lastInsertRowid);

  // 中断相遇 B：旧存档已按 LLM 摘要入账过 → 重启只收尾，旧文本原样保留、不重复结算
  const encB = db.prepare(`INSERT INTO town_encounters (map_id, char_a, char_b, location_id, status, summary)
    VALUES (?, ?, ?, (SELECT id FROM town_locations WHERE map_id = ? AND key = 'plaza'), 'chatting', '旧摘要：两人聊起了茶叶')`)
    .run(sim.mapId, -sim.npcIds[0], -sim.npcIds[1], sim.mapId);
  const encBId = Number(encB.lastInsertRowid);
  const legacyEvents = createTownEventService({
    db, clock: { now: () => sim.now },
    getWorldEpoch: worldId => registry.getWorldEpoch(worldId),
    validators: {
      'town.encounter.happened': payload => !!payload && Number.isSafeInteger(payload.encounterId)
        && payload.encounterId > 0 && typeof payload.summary === 'string'
        && payload.summary.trim().length > 0 && payload.summary.length <= 200,
    },
  });
  legacyEvents.append({
    eventId: `encounter:${encBId}`, ...scope,
    type: 'town.encounter.happened', occurredAt: sim.now,
    actorIds: actors, source: { system: 'town.encounters', entityId: `encounter:${encBId}` },
    payload: { encounterId: encBId, summary: '旧摘要：两人聊起了茶叶' },
  }, ['town.experience']);

  // 重启：loadState → closeStaleEncounters 保守恢复
  sim.start();
  const rowA = db.prepare('SELECT * FROM town_encounters WHERE id = ?').get(encAId);
  assert.equal(rowA.status, 'done', '中断相遇应被保守收尾');
  assert.equal(JSON.parse(rowA.outcome_json).resultCode, 'interrupted', '收尾结果代码为 interrupted');
  assert.equal(rowA.summary, '看店的阿圆和散步的小林在中央广场的谈话被打断了。', '补结算使用模板摘要');
  const rowB = db.prepare('SELECT * FROM town_encounters WHERE id = ?').get(encBId);
  assert.equal(rowB.status, 'done');
  assert.equal(rowB.summary, '旧摘要：两人聊起了茶叶', '已入账的历史相遇保留旧文本');
  assert.equal(rowB.outcome_json, null, '历史相遇不补写结构化结果');

  // 中断相遇 A 补结算产生事件并沉淀经历；历史相遇 B 不重复入账
  sim.step(30_000);
  assert.equal(countByEvent(`encounter:${encAId}`), 2, '中断相遇补结算后双方各一条经历');
  assert.equal(countByEvent(`encounter:${encBId}`), 2, '历史相遇保留原有经历（不重复入账）');

  // 再次重启：同一来源不重复结算
  sim.stop();
  sim.start();
  sim.step(30_000);
  assert.equal(countByEvent(`encounter:${encAId}`), 2, '重复恢复不得新增经历');
  assert.equal(countByEvent(`encounter:${encBId}`), 2);
  assert.equal(db.prepare('SELECT count(*) n FROM town_domain_events WHERE event_id = ?').get(`encounter:${encAId}`).n, 1);
  const rowA2 = db.prepare('SELECT outcome_json FROM town_encounters WHERE id = ?').get(encAId);
  assert.equal(JSON.parse(rowA2.outcome_json).resultCode, 'interrupted');
});
