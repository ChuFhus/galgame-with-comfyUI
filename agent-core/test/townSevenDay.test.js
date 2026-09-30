import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`seven-day fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { economyEnabled: false, liquidityEnabled: false, playerSpeed: 1, npcSpeed: 1,
  timeZone: 'Asia/Shanghai', maxActiveEncounters: 1, encounterStrangerProb: 1, encounterRelatedProb: 1,
  encounterMinStartGapMin: 0 });
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');

const T0 = Date.parse('2026-09-30T09:00:00+08:00');
const db = getDb();

/** 全体居民需求都有界且有限 */
function assertNeedsBounded() {
  const actors = db.prepare('SELECT actor_id, needs_json FROM town_resident_needs').all();
  for (const row of actors) {
    for (const [key, value] of Object.entries(JSON.parse(row.needs_json))) {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 100, `${key} 应有界，实际 ${value}`);
    }
  }
}

// 七天长模拟（§9.2 系统级验证）：默认跳过，设 TOWN_LONG_SIM=1 运行（npm 门外诊断用）
const longTest = process.env.TOWN_LONG_SIM === '1' ? test : test.skip;
longTest('T07/M5 七天 + 十四天场景：三条闭环与目标技能长期稳定（零模型）', async t => {
  let now = T0;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clockRef = { now };
  t.mock.method(Date, 'now', () => clockRef.now);
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });

  // tickSeconds=300 → 动作租约 15 分钟，允许 10 分钟步长（租约安全）
  config.town.tickSeconds = 300;
  const sim = createTownHeadlessSim({ startUtcMs: now, name: 'seven-days',
    locations: [
      { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 6, y: 6, radius: 3 },
      { key: 'food', name: '老字号饭馆', kind: 'place', businessKind: 'tavern', x: 2, y: 2, radius: 1 },
      { key: 'food2', name: '巷口小吃', kind: 'place', businessKind: 'cafe', x: 10, y: 10, radius: 1 },
      { key: 'study', name: '街尾书斋', kind: 'place', businessKind: 'study', x: 2, y: 10, radius: 1 },
      { key: 'home_a', name: '西边小院', kind: 'home', x: 1, y: 1, radius: 1 },
      { key: 'home_b', name: '东边小院', kind: 'home', x: 11, y: 1, radius: 1 },
    ],
    residents: [
      { displayName: '掌柜老周', job: '饭馆掌柜', routine: [{ start: '07:00', end: '21:00', locationKey: 'food', actionType: 'work_shift', activity: '营业' }] },
      { displayName: '书生小沈', job: '书斋先生', routine: [{ start: '08:00', end: '20:00', locationKey: 'study', actionType: 'work_shift', activity: '看店' }] },
      { displayName: '闲散的阿圆', job: '居民' },
      { displayName: '爱走的阿快', job: '居民' },
    ] });
  const step = async (ms = 10 * 60_000) => { now += ms; sim.step(ms); clockRef.now = now; await new Promise(r => setImmediate(r)); };

  const fourteenDaysMs = 14 * 24 * 3600_000;
  let ticks = 0;
  while (now < T0 + fourteenDaysMs && ticks++ < 2400) await step();
  assert.ok(now >= T0 + fourteenDaysMs, '虚拟时钟应走满十四天');

  // 生活闭环：需求全程有界；进食动作发生过且恢复来源幂等
  assertNeedsBounded(sim);
  const eatSettled = db.prepare(`SELECT count(*) n FROM town_need_effects WHERE source_key LIKE 'life_eat:%'`).get().n;
  assert.ok(eatSettled > 0, '七天里应发生自主进食');
  // 经济闭环：工资与餐费交易存在；账本守恒
  console.log('DBG tx:', JSON.stringify(db.prepare(`SELECT reason_code, count(*) n FROM economy_transactions GROUP BY reason_code`).all()));
  console.log('DBG actions:', JSON.stringify(db.prepare(`SELECT type, status, count(*) n FROM town_actions GROUP BY type, status`).all()));
  assert.ok(db.prepare(`SELECT 1 FROM economy_transactions WHERE reason_code = 'SHIFT_WAGE'`).get(), '应发过工资');
  const total = db.prepare(`SELECT SUM(e.amount) total FROM economy_entries e`).get().total;
  assert.equal(Number(total), 0, '复式账本守恒');
  // 社会闭环：相遇按规则结算、经历沉淀、关系单调有界
  const unsettled = db.prepare(`SELECT count(*) n FROM town_encounters WHERE status='done' AND outcome_json IS NULL`).get().n;
  assert.equal(unsettled, 0, '所有完成的相遇都应有结构化结算');
  assert.ok(db.prepare('SELECT count(*) n FROM town_experiences').get().n > 0, '应有经历沉淀');
  const badRel = db.prepare(`SELECT count(*) n FROM town_actor_relationships
    WHERE familiarity < 0 OR familiarity > 100 OR affection < -100 OR affection > 100`).get().n;
  assert.equal(badRel, 0, '关系数值有界');
  // M5：十四天后出现可解释的目标进度与技能积累（有界、可追溯）
  const progressed = db.prepare('SELECT count(*) n FROM town_resident_goals WHERE progress > 0').get().n;
  assert.ok(progressed > 0, '应有目标产生进度');
  const skilled = db.prepare('SELECT count(*) n FROM town_resident_skills WHERE level > 0').get().n;
  assert.ok(skilled > 0, '应有技能或习惯积累');
  const badSkills = db.prepare(`SELECT count(*) n FROM town_resident_skills WHERE level < 0 OR level > 100`).get().n;
  assert.equal(badSkills, 0, '技能等级有界');
});
