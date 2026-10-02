@echo off
title Linshe DB Cleanup
rem ============================================================
rem  Linshe one-shot database cleanup (re-runnable).
rem  Usage: put THIS file in the project ROOT (next to the
rem  launcher exe), close the app, then double-click. The app
rem  will be closed automatically if it is running.
rem  Node runtime: bundled runtime/nodejs*/ first, then PATH
rem  (same discovery order as the launcher).
rem  This file = small batch shell + embedded JS payload after
rem  the ___JS___ marker. Readable/auditable. Only removes
rem  runtime garbage; characters/chats/memories never touched.
rem ============================================================

set "LINSHE_CORE=%~dp0agent-core"
if not exist "%LINSHE_CORE%\package.json" (
  echo [X] agent-core\package.json not found here.
  echo     Put this file in the project ROOT folder, then run again.
  echo.
  pause
  exit /b 1
)
if not exist "%LINSHE_CORE%\data\agent.db" (
  echo [X] agent-core\data\agent.db not found.
  echo.
  pause
  exit /b 1
)

rem Node runtime discovery: bundled runtime/nodejs*/ first, then PATH
set "LINSHE_NODE="
for /d %%d in ("%~dp0runtime\nodejs*") do (
  if exist "%%d\node.exe" set "LINSHE_NODE=%%d\node.exe"
)
if defined LINSHE_NODE goto :have_node
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found: no bundled runtime\nodejs*\ and no system node.
  echo     Start the app once via its launcher, or install Node.js.
  echo.
  pause
  exit /b 1
)
set "LINSHE_NODE=node"
:have_node

echo Extracting embedded cleanup script...
set "LINSHE_SCRIPT=%~f0"
powershell -NoProfile -Command "$c=[IO.File]::ReadAllLines($env:LINSHE_SCRIPT); $i=[Array]::IndexOf($c,'___JS___'); if($i -lt 0){exit 1}; [IO.File]::WriteAllLines($env:TEMP+'\linshe_db_cleanup.cjs', $c[($i+1)..($c.Count-1)])"
if errorlevel 1 (
  echo [X] Failed to extract the embedded script.
  pause
  exit /b 1
)

echo.
echo Do NOT close this window while cleaning. Progress will be printed.
echo The app will be closed automatically if it is running.
echo Large databases may take 10-30 minutes.
echo.
set /p LINSHE_CONFIRM=Type Y and press Enter to start cleaning:
if /i not "%LINSHE_CONFIRM%"=="Y" (
  echo Cancelled.
  pause
  exit /b 0
)

cd /d "%LINSHE_CORE%"
"%LINSHE_NODE%" "%TEMP%\linshe_db_cleanup.cjs" "%LINSHE_CORE%"
set LINSHE_RC=%errorlevel%
del "%TEMP%\linshe_db_cleanup.cjs" >nul 2>nul
echo.
if "%LINSHE_RC%"=="0" (echo Cleanup finished.) else (echo Cleanup failed - please send the full output above to the author.)
pause
exit /b %LINSHE_RC%
___JS___
// 邻舍数据库一键清理（由批处理外壳解包后以 node 运行；本行起为 JS 载荷）
// 只删运行垃圾：已结束的动作流水（保留 24 小时，动态流水页按条数读最新记录且
// 排除 cancelled）、命令幂等缓存、旧世界纪元/停产类型/30 天前的事件日志。
// 角色/聊天/记忆/经历等用户数据一律不碰。
// 实现方式：对百万级大表用「复制幸存行 → 换名」的整表重建，而不是逐行 DELETE——
// 机械盘上逐行删除要为每行随机更新主键索引页（数十小时），重建只需顺序扫描（几分钟）。
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const RETENTION_DAYS = 7;   // 导演候选等保留天数（与服务器内置任务一致）
const ACTIONS_RETENTION_HOURS = 24; // 已结束动作流水保留窗口：动态流水页按条数读最新记录，旧版本 churn 数据无需长留

const appDir = (process.argv[2] || process.cwd()).replace(/[\\/"]+$/, '');
const dbPath = path.join(appDir, 'data', 'agent.db');
const fmtGB = n => (n / 1073741824).toFixed(2) + ' GB';
const DAY = 86400000;
const sleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const say = m => console.log(m);
const fail = m => { say('[X] ' + m); process.exit(1); };

let Database;
try { Database = require(path.join(appDir, 'node_modules', 'better-sqlite3')); }
catch (e) { fail('未找到 better-sqlite3 模块——请在程序目录内运行本脚本。'); }

if (!fs.existsSync(dbPath)) fail('未找到数据库 ' + dbPath);

// ── 运行中检测：发现邻舍进程就自动结束它，专心清理 ──
const ps = script => {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return execSync(`powershell -NoProfile -EncodedCommand ${b64}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
};
const psJson = script => {
  try {
    const r = JSON.parse(ps(script) || 'null');
    return Array.isArray(r) ? r : r ? [r] : [];
  } catch { return []; }
};
const isNode = name => /^node(\.exe)?$/i.test(name || '');
function port3099Pids() {
  try {
    const out = execSync('netstat -ano | findstr ":3099"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))];
  } catch { return []; }
}
function procInfo(pid) {
  return psJson(`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object Name,ParentProcessId | ConvertTo-Json -Compress`)[0] || null;
}
function findAppProcs() {
  // 邻舍后端 = node.exe 且命令行含 app.js（兼容改过端口/免 nodemon 启动）
  return psJson(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'app\\.js' } |
    Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`);
}
function topNodeAncestor(pid) {
  // 沿父链向上找最顶层的 node 祖先（npm → 监控器 → app.js），对它整树结束
  let cur = pid, top = pid, hops = 0;
  while (cur > 4 && hops++ < 15) {
    const p = procInfo(cur);
    if (!p || !isNode(p.Name)) break;
    top = cur;
    cur = p.ParentProcessId;
  }
  return top;
}
function ensureAppClosed() {
  for (let round = 0; round < 2; round++) {
    const listeners = port3099Pids();
    const procs = findAppProcs();
    if (!listeners.length && !procs.length) return true;
    say('检测到邻舍正在运行，正在自动关闭以专心清理...');
    const kill = new Set(procs.map(p => topNodeAncestor(p.ProcessId)));
    for (const pid of listeners) {
      const info = procInfo(pid);
      if (info && isNode(info.Name)) kill.add(topNodeAncestor(pid));
      else fail(`端口 3099 被其他程序（PID ${pid}）占用，无法自动处理，请手动解决后再运行本脚本。`);
    }
    for (const pid of kill) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* 已自行退出 */ }
    }
    // 启动器（邻舍.EXE.exe）可能守护后端：一并结束
    for (const img of ['邻舍.EXE.exe', 'NeighborExe.exe']) {
      try { execSync(`taskkill /IM "${img}" /F`, { stdio: 'ignore' }); } catch (e) { /* 未在运行 */ }
    }
    sleep(2000);
    if (!port3099Pids().length && !findAppProcs().length) return true;
  }
  return !port3099Pids().length && !findAppProcs().length;
}
if (!ensureAppClosed()) fail('邻舍进程未能自动关闭——请手动关闭后重试。');

let db;
try { db = new Database(dbPath); }
catch (e) { fail('数据库被占用或无法打开：' + e.message); }
db.pragma('busy_timeout = 3000');
db.pragma('foreign_keys = ON');

// ── 运行中检测（兜底闸）：抢占写锁。程序在跑就几乎必然撞上 ──
let locked = true;
for (let i = 0; i < 3 && locked; i++) {
  try { db.exec('BEGIN IMMEDIATE'); db.exec('COMMIT'); locked = false; }
  catch (e) { say('    数据库正被占用，2 秒后重试...'); sleep(2000); }
}
if (locked) fail('数据库持续被占用——请确认程序已完全关闭后重试。');

const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const count = t => db.prepare('SELECT count(*) n FROM ' + t).get().n;
const sizeOf = p => { try { return fs.statSync(p).size; } catch { return 0; } };

const sizeBefore = sizeOf(dbPath);
const T0 = Date.now();
const ts = () => '[' + Math.round((Date.now() - T0) / 1000) + 's] ';
const sayT = m => say(ts() + m);
say('==============================================');
say(' 邻舍数据库一键清理');
say('==============================================');
say('数据库：' + dbPath);
say('当前体积：' + fmtGB(sizeBefore));

say('正在统计各表行数（大库首次读取可能需要几分钟，请稍候）...');
const stats = {};
for (const t of ['town_actions', 'town_activity_log', 'town_action_requests', 'town_domain_events']) {
  stats[t] = has(t) ? count(t) : -1;
}
say('动作流水 ' + stats.town_actions + ' 行 | 审计 ' + stats.town_activity_log
  + ' 行 | 幂等记录 ' + stats.town_action_requests + ' 行 | 事件日志 ' + stats.town_domain_events + ' 行');
say('');

const done = [];

/**
 * 整表重建：建一张同构新表 → 复制保留谓词命中的幸存行 → 换名顶替原表。
 * 机械盘上逐行 DELETE 百万级数据要为每行随机更新主键索引页（几十小时），
 * 重建只需一次顺序扫描 + 幸存行的顺序写入（几分钟）。
 * 返回 { total, kept }；表不存在返回 null。
 */
function rebuildTable(name, keepWhere) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!row || !row.sql) return null;
  const idxSqls = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
    .all(name).map(r => r.sql);
  const total = count(name);
  const hb = spawn(process.execPath, ['-e',
    `const t0=Date.now();setInterval(()=>console.log("      ${name} 重建中，已耗时 "+Math.round((Date.now()-t0)/1000)+"s ..."),10000)`],
    { stdio: 'inherit' });
  try {
    const createNew = row.sql.replace(new RegExp('CREATE TABLE\\s+("?' + name + '"?)', 'i'), m => m + '__rebuild');
    db.exec(`DROP TABLE IF EXISTS ${name}__rebuild`);
    db.exec(createNew);
    const cols = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name).join(',');
    let kept = 0;
    if (keepWhere) {
      kept = db.prepare(`INSERT INTO ${name}__rebuild(${cols}) SELECT ${cols} FROM ${name} WHERE ${keepWhere}`).run().changes;
    }
    db.exec(`DROP TABLE ${name}`);
    db.exec(`ALTER TABLE ${name}__rebuild RENAME TO ${name}`);
    for (const s of idxSqls) db.exec(s);
    return { total, kept };
  } finally { hb.kill(); }
}

(async () => {
  // ── 1. 备份（失败即取消，不动任何数据）──
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const backupPath = path.join(appDir, 'data', 'agent.db.cleanup-backup-' + stamp);
  say('[1/6] 备份数据库 → ' + path.basename(backupPath));
  say('      （大库需要几分钟；确认程序一切正常后可手动删除备份）');
  let lastPct = -10;
  try {
    await db.backup(backupPath, { progress: ({ totalPages, remainingPages }) => {
      const pct = totalPages ? Math.floor((totalPages - remainingPages) * 100 / totalPages) : 100;
      if (pct >= lastPct + 10 || remainingPages === 0) { lastPct = pct; say('      备份进度 ' + pct + '%'); }
    } });
  }
  catch (e) { fail('备份失败，已取消清理：' + e.message); }
  say('      备份完成 ' + fmtGB(sizeOf(backupPath)));
  say('');

  // 换名期间关闭 FK 校验（幸存行引用的行全部随表保留；孤儿引用随后统一清理）
  db.pragma('foreign_keys = OFF');

  // ── 2. 动作流水：重建，只保留在途 + 最近 24 小时 ──
  if (has('town_actions')) {
    sayT('[2/6] 重建动作流水（只保留在途 + 最近 24 小时，其余删除）...');
    const cutoff = Date.now() - ACTIONS_RETENTION_HOURS * 3600_000;
    const r = rebuildTable('town_actions',
      `status IN ('validated','reserved','running') OR updated_at >= ${cutoff}`);
    // 清理指向已删动作的孤儿引用（claims/proofs 生命周期内的合法引用不受影响）
    if (has('town_resource_claims')) {
      db.exec('DELETE FROM town_resource_claims WHERE action_id NOT IN (SELECT id FROM town_actions)');
    }
    if (has('town_production_proofs')) {
      db.exec('DELETE FROM town_production_proofs WHERE action_id NOT IN (SELECT id FROM town_actions)');
    }
    done.push(`动作流水 ${r.total} → ${r.kept} 行`);
    sayT('      完成：' + r.total + ' → ' + r.kept + ' 行');
  }

  // ── 3. 命令幂等记录：运行时去重缓存，整表清空（服务停止时绝对安全）──
  if (has('town_action_requests')) {
    sayT('[3/6] 清空命令幂等记录（重建空表）...');
    const r = rebuildTable('town_action_requests', null);
    done.push('幂等记录 ' + r.total + ' → 0 行');
    sayT('      完成：' + r.total + ' → 0 行');
  }

  // ── 4. 事件日志：重建，保留当前纪元 / 记忆凭证 / 未投递事件 ──
  if (has('town_domain_events')) {
    sayT('[4/6] 重建事件日志（保留当前纪元 / 记忆凭证 / 未投递事件，其余删除）...');
    const epochRow = has('town_world_state') ? db.prepare('SELECT epoch FROM town_world_state').get() : null;
    const cur = epochRow && Number.isSafeInteger(epochRow.epoch) ? epochRow.epoch : 0;
    const keepWhere = `(
        world_epoch >= ${cur} AND type <> 'town.action.changed'
        AND COALESCE(CAST(json_extract(envelope, '$.occurredAt') AS INTEGER), 9223372036854775807) >= ${Date.now() - 30 * DAY}
      )
      OR EXISTS (SELECT 1 FROM town_experiences x WHERE x.event_id = town_domain_events.event_id)
      OR EXISTS (SELECT 1 FROM town_event_deliveries d WHERE d.event_id = town_domain_events.event_id
        AND d.status IN ('pending','processing'))`;
    const r = rebuildTable('town_domain_events', keepWhere);
    done.push(`事件日志 ${r.total} → ${r.kept} 行`);
    sayT('      完成：' + r.total + ' → ' + r.kept + ' 行');
  }

  // ── 5. 其他运行残留 + 废弃表 ──
  sayT('[5/6] 清理候选/相遇/投递状态等运行残留...');
  const eco = [];
  if (has('town_activity_log')) {
    // 新版已废弃该表（理由上移 town_actions.last_reason）：纯写入审计无读者，整表删除
    db.exec('DROP TABLE town_activity_log');
    eco.push('废弃审计表 town_activity_log 已移除');
  }
  if (has('town_event_deliveries')) {
    const r = rebuildTable('town_event_deliveries', "status IN ('pending','processing')");
    if (r.total !== r.kept) eco.push('投递状态 ' + r.total + ' → ' + r.kept + ' 行');
  }
  if (has('town_director_candidates')
    && db.prepare('PRAGMA table_info(town_director_candidates)').all().some(c => c.name === 'created_utc_ms')) {
    const r = rebuildTable('town_director_candidates', 'created_utc_ms >= ' + (Date.now() - RETENTION_DAYS * DAY));
    if (r.total !== r.kept) eco.push('导演候选 ' + r.total + ' → ' + r.kept + ' 行');
  }
  if (has('town_encounters')) {
    const r = rebuildTable('town_encounters',
      "COALESCE(ended_at, created_at) >= '" + new Date(Date.now() - 30 * DAY).toISOString().slice(0, 19).replace('T', ' ') + "'");
    if (r.total !== r.kept) eco.push('相遇 ' + r.total + ' → ' + r.kept + ' 行');
  }
  say('      ' + (eco.length ? eco.join('，') : '无残留'));
  if (eco.length) done.push(eco.join('，'));

  db.pragma('foreign_keys = ON');
  const fkIssues = db.pragma('foreign_key_check').length;
  if (fkIssues) say(`    注意：发现 ${fkIssues} 条跨表孤儿引用（不影响使用，已保留）`);

  // ── 6. 压缩 + 校验 ──
  sayT('[6/6] VACUUM 压缩（大库需要几分钟到十几分钟，期间窗口无响应、每 10 秒心跳，请勿关闭）...');
  const hb = spawn(process.execPath, ['-e',
    'const t0=Date.now();setInterval(()=>console.log("      压缩进行中，已耗时 "+Math.round((Date.now()-t0)/1000)+"s ..."),10000)'],
    { stdio: 'inherit' });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  hb.kill();
  sayT('      完整性校验：' + db.pragma('integrity_check', { simple: true }));

  const sizeAfter = sizeOf(dbPath);
  say('');
  say('==============================================');
  say(' 清理完成（用时 ' + Math.round((Date.now() - T0) / 1000) + ' 秒）');
  for (const line of done) say('  · ' + line);
  say('  体积：' + fmtGB(sizeBefore) + ' → ' + fmtGB(sizeAfter));
  say(' 备份：' + path.basename(backupPath) + '（确认正常后可手动删除）');
  say('==============================================');
  say(' 治本提醒：请把程序更新到最新版本——新版已内置自动');
  say(' 清理与自动压缩，更新后不再需要手动运行本脚本。');
  db.close();
  process.exit(0);
})().catch(e => {
  say('[X] 清理中断：' + (e && e.message || e));
  say('    数据库已有备份：data/ 目录下 agent.db.cleanup-backup-*');
  process.exit(1);
});
