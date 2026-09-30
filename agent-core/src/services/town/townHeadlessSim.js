/**
 * 无界面模拟入口（M0：仅测试与诊断使用，不接入任何路由）。
 *
 * 用预置地图、居民与虚拟时钟驱动 townService 的真实主循环（forceTick(nowMs)），
 * 不依赖 HTTP、LLM 或生图——调用方需保证 fetch 被禁用、config.features.townLLM/
 * townAutoLLM 关闭（零模型口径），即可复现「关闭模型小镇仍能生活」的场景。
 *
 * 用法参见 agent-core/test/townEncounterSettlement.test.js。
 */
import { saveMap } from './townMapService.js';
import { createNpc } from './townNpcService.js';
import { touchTownViewer, forceTick, getTownState, startTownScheduler, stopTownScheduler } from './townService.js';
import { config } from '../../config.js';

const DEFAULT_LOCATIONS = [
  { key: 'plaza', name: '中央广场', kind: 'outdoor', x: 4, y: 4, radius: 2 },
  { key: 'home_a', name: '西边小院', kind: 'home', x: 1, y: 1, radius: 1 },
  { key: 'home_b', name: '东边小院', kind: 'home', x: 10, y: 1, radius: 1 },
];

/**
 * 搭一个预置小街并启动小镇调度器。
 * @param {object} [options]
 * @param {string} [options.name] 地图名
 * @param {Array}  [options.locations] 地点（缺省为广场 + 两处住宅）
 * @param {Array}  [options.residents] 居民 [{ displayName, job, routine }]；缺省两位钉在广场的居民
 * @param {number} [options.startUtcMs] 虚拟时钟起点
 * @param {boolean} [options.viewer] 是否模拟页面在线（心跳）；缺省 false（后台口径）
 */
export function createTownHeadlessSim({
  name = 'headless town',
  cols = 12, rows = 12,
  locations = DEFAULT_LOCATIONS,
  residents = [
    { displayName: '看店的阿圆', job: '居民', routine: [{ start: '07:00', end: '22:00', locationKey: 'plaza', activity: '看店' }] },
    { displayName: '散步的小林', job: '居民', routine: [{ start: '07:00', end: '22:00', locationKey: 'plaza', activity: '散步' }] },
  ],
  startUtcMs = Date.parse('2026-09-30T09:00:00+08:00'),
  viewer = false,
} = {}) {
  const grid = () => Array.from({ length: rows }, () => Array(cols).fill(null));
  const { mapId } = saveMap({ create: true, name, cols, rows,
    layers: { ground: grid(), road: grid(), objects: [] }, locations });
  const npcIds = residents.map(resident =>
    createNpc({ mapId, displayName: resident.displayName, job: resident.job || '',
      routine: resident.routine || [], workplaceKey: resident.workplaceKey ?? null,
      traits: resident.traits || {} }).id);

  startTownScheduler();
  let now = startUtcMs;
  return {
    mapId,
    npcIds,
    get now() { return now; },
    /** 推进虚拟时钟并驱动一拍（步骤粒度自定，推荐 30s/60s） */
    step(ms = 60_000) { now += ms; if (viewer) touchTownViewer(); forceTick(now); },
    /** 当前图（或指定图）的服务端状态快照 */
    state(mapIdArg = null) { return getTownState(mapIdArg ?? mapId); },
    /** 重新装载世界（模拟进程重启后的保守恢复路径） */
    start() { startTownScheduler(); },
    stop() { stopTownScheduler(); },
    get running() { return config.features.town; },
  };
}
