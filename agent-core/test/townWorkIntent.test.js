import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw Error(`work intent fixture forbids network: ${url}`); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
config.dbPath = ':memory:';
getDb();
config.features.town = true;
config.features.townLLM = false;
config.features.townAutoLLM = false;
Object.assign(config.town, { playerSpeed: 1, npcSpeed: 1, timeZone: 'Asia/Shanghai' });
const { createTownHeadlessSim } = await import('../src/services/town/townHeadlessSim.js');
const { createTownActorRegistry } = await import('../src/services/town/townActorRegistry.js');

test('工作接线：作息段落在同类经营场所（或多店同类的另一家）即视为在岗，未同类则不判在岗', async t => {
  let now = Date.parse('2026-09-30T10:00:00+08:00');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clockRef = { now };
  t.mock.method(Date, 'now', () => clockRef.now);
  const db = getDb();
  const registry = createTownActorRegistry(db);
  t.after(() => { sim.stop(); closeDb(); t.mock.timers.reset(); });

  // 两家同 kind 的沙龙（复刻真实世界：绑定 workplace 与作息段指向同类的不同分店）
  const sim = createTownHeadlessSim({ startUtcMs: now, name: 'work-intent',
    locations: [
      { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 6, y: 6, radius: 3 },
      { key: 'slime_salon', name: '史莱姆吸盘沙龙', kind: 'place', businessKind: 'salon', x: 2, y: 2, radius: 1 },
      { key: 'salon', name: '猫耳敏感点美容室', kind: 'place', businessKind: 'salon', x: 10, y: 2, radius: 1 },
      { key: 'tavern', name: '梦魔风俗酒馆', kind: 'place', businessKind: 'tavern', x: 2, y: 10, radius: 1 },
    ],
    residents: [
      // 绑定岗位 = slime_salon，作息段却指向同类另一家 salon → 仍应判在岗（真实世界的数据形态）
      { displayName: '沙龙店主诺瓦', job: '沙龙店主', workplaceKey: 'slime_salon',
        routine: [{ start: '00:00', end: '24:00', locationKey: 'salon', activity: '开门迎客' }] },
      // 绑定岗位 = tavern，作息段在人家的沙龙 → kind 不匹配，不判在岗（只是去串门）
      { displayName: '酒保阿慢', job: '酒保', workplaceKey: 'tavern',
        routine: [{ start: '00:00', end: '24:00', locationKey: 'salon', activity: '闲坐' }] },
    ] });

  const actors = sim.npcIds.map(id => registry.resolveAgentKey(`npc:${id}`).actorId);
  const step = async (ms = 60_000) => { now += ms; sim.step(ms); clockRef.now = now; await new Promise(r => setImmediate(r)); };
  for (let i = 0; i < 30; i++) await step();

  const shifts = db.prepare(`SELECT a.actor_id, a.target, a.status FROM town_actions a
    WHERE a.type = 'work_shift'`).all();
  const nowaShifts = shifts.filter(s => s.actor_id === actors[0]);
  assert.ok(nowaShifts.length > 0, '同类分店的作息段应被判为在岗（生成 work_shift）');
  assert.ok(nowaShifts.every(s => s.target === 'salon'), '在岗位置就是作息段所在地点');
  assert.equal(shifts.filter(s => s.actor_id === actors[1]).length, 0, 'kind 不匹配不判在岗');

  // 出勤完成 → 由该店经营账户发工资（钱从场所账户出，不增发）
  const wages = db.prepare(`SELECT count(*) n FROM economy_transactions WHERE reason_code = 'SHIFT_WAGE'`).get().n;
  assert.ok(wages > 0, '在岗出勤应产生工资结算');
  const venueAccount = db.prepare(`SELECT balance FROM economy_accounts WHERE owner_key = 'venue:${sim.mapId}:salon'`).get();
  assert.ok(venueAccount, '工资从作息段所在地点的经营账户支出');
});
