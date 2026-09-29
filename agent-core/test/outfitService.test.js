import { test, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const { getLocalDateKey } = await import('../src/utils/localDate.js');
const svc = await import('../src/services/outfitService.js');

config.dbPath = ':memory:';

function seedTodayPaper(db, { worldState, dismissed = 0 }) {
  db.prepare('DELETE FROM town_newspapers').run();
  db.prepare(`
    INSERT INTO town_newspapers (publish_date, name, edition, items_json, character_id, character_event_json, world_state_json, world_dismissed, moment_done, complaint_after)
    VALUES (?, '邻舍日报', 1, '[]', NULL, NULL, ?, ?, 0, NULL)
  `).run(getLocalDateKey(), worldState ? JSON.stringify(worldState) : null, dismissed);
}

test('getActiveOutfits injects today newspaper world_state outfit into limited', () => {
  const db = getDb();
  t_clean(db);
  seedTodayPaper(db, {
    worldState: {
      name: '全镇兔女郎',
      description: '全镇居民今天都换上了兔女郎装。',
      outfit: '黑色缎面抹胸兔女郎装，白色假领口与袖口，头戴兔耳发箍。',
      effect_prompt: '今天你穿着兔女郎服。',
    },
  });

  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('wschar', '换装小姐', 'x')`).run();
  const charId = db.prepare(`SELECT id FROM characters WHERE name = 'wschar'`).get().id;

  const outfits = svc.getActiveOutfits(charId);
  const worldEntry = outfits.limited.find(o => o.id === 'world_state');
  assert.ok(worldEntry, 'world_state outfit must appear in limited');
  assert.equal(worldEntry.name, '全镇状态 · 全镇兔女郎');
  assert.equal(worldEntry.description, '黑色缎面抹胸兔女郎装，白色假领口与袖口，头戴兔耳发箍。');

  // 与道具限时服饰同槽位：已有的 global_outfits 行不受影响，两者并存
  db.prepare(`INSERT INTO global_outfits (name, description, enabled, character_id, expires_at) VALUES ('女仆装', '经典黑白女仆装。', 1, ?, NULL)`).run(charId);
  const both = svc.getActiveOutfits(charId).limited;
  assert.equal(both.length, 2, 'item outfit and world_state outfit stack');
  assert.ok(both.some(o => o.name === '女仆装'));
  assert.ok(both.some(o => o.id === 'world_state'));
});

test('getActiveOutfits skips world_state outfit when dismissed, missing outfit field, or stale paper', () => {
  const db = getDb();
  t_clean(db);
  const ws = { name: '全镇猫化', description: '大家都长出了猫耳。', outfit: '毛茸茸的猫耳与尾巴。', effect_prompt: '今天你有猫耳。' };
  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('wschar2', '观察小姐', 'x')`).run();
  const charId = db.prepare(`SELECT id FROM characters WHERE name = 'wschar2'`).get().id;

  // 已消除（world_dismissed=1）→ 不注入
  seedTodayPaper(db, { worldState: ws, dismissed: 1 });
  assert.ok(!svc.getActiveOutfits(charId).limited.some(o => o.id === 'world_state'));

  // 旧报纸没有 outfit 字段 → 不注入
  seedTodayPaper(db, { worldState: { name: '旧状态', description: 'd', effect_prompt: 'e' } });
  assert.ok(!svc.getActiveOutfits(charId).limited.some(o => o.id === 'world_state'));

  // 当天无报纸 → 不注入
  db.prepare('DELETE FROM town_newspapers').run();
  assert.ok(!svc.getActiveOutfits(charId).limited.some(o => o.id === 'world_state'));

  // 昨天的报纸（哪怕有 outfit）→ 不注入
  db.prepare(`
    INSERT INTO town_newspapers (publish_date, name, edition, items_json, character_id, character_event_json, world_state_json, world_dismissed, moment_done, complaint_after)
    VALUES ('2026-09-28', '邻舍日报', 1, '[]', NULL, NULL, ?, 0, 0, NULL)
  `).run(JSON.stringify(ws));
  assert.ok(!svc.getActiveOutfits(charId).limited.some(o => o.id === 'world_state'));
});

function t_clean(db) {
  db.prepare('DELETE FROM town_newspapers').run();
  db.prepare('DELETE FROM global_outfits').run();
  db.prepare(`DELETE FROM characters WHERE name LIKE 'wschar%'`).run();
}

after(() => closeDb());
