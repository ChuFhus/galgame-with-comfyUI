import { Router } from 'express';
import {
  getTodayNewspaperForFrontend,
  maybeGenerateDailyNewspaper,
  setWorldStateDismissed,
  listNewspaperEditions,
  getNewspaperByDate,
} from '../services/newspaperService.js';

const router = Router();

// GET /api/newspaper/today — 今天的《邻舍日报》（没有则 { newspaper: null }）
router.get('/today', (req, res) => {
  res.json({ newspaper: getTodayNewspaperForFrontend() });
});

// GET /api/newspaper/editions — 历史期简目（最新在前，供期号导航）
router.get('/editions', (req, res) => {
  res.json({ editions: listNewspaperEditions() });
});

// GET /api/newspaper/by-date/:date — 按日期回看某一期（YYYY-MM-DD）
router.get('/by-date/:date', (req, res) => {
  res.json({ newspaper: getNewspaperByDate(req.params.date) });
});

// POST /api/newspaper/generate — 手动补发今天的报纸（已存在则直接返回现有内容）
router.post('/generate', async (req, res) => {
  const existing = getTodayNewspaperForFrontend();
  if (existing) {
    res.json({ newspaper: existing, started: false });
    return;
  }
  const task = maybeGenerateDailyNewspaper();
  if (!task) {
    res.status(409).json({ error: '当前不满足生成条件（清晨时段外 / 刚失败冷却中 / 已在生成）' });
    return;
  }
  res.json({ started: true });
});

// POST /api/newspaper/dismiss-world — 消除/恢复今天的世界影响
// body 可选 { dismissed: boolean }：true=消除（当天不再注入），false=恢复；省略则按当前状态切换
router.post('/dismiss-world', (req, res) => {
  const paper = getTodayNewspaperForFrontend();
  if (!paper?.world_state) {
    res.json({ ok: false, error: '今天的报纸没有世界影响', newspaper: paper });
    return;
  }
  const target = typeof req.body?.dismissed === 'boolean'
    ? req.body.dismissed
    : !paper.world_dismissed;
  setWorldStateDismissed(target);
  res.json({ ok: true, dismissed: target, newspaper: getTodayNewspaperForFrontend() });
});

export default router;
