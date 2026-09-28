import { Router } from 'express';
import { getDb } from '../db/index.js';
import { listExpressionStandings, startStandingBatch, controlStandingBatch, updateStandingPrompt, editStandingImage, deleteStanding } from '../services/expressionStandingService.js';
import { getStandingDisplay } from '../services/standingDisplay.js';

const router = Router();
const base = '/characters/:id/expression-standings';
router.get(base, (req, res) => res.json(listExpressionStandings(req.params.id)));
router.post(`${base}/generate`, (req, res) => res.status(202).json(startStandingBatch(req.params.id, req.body)));
router.post(`${base}/jobs/:jobId/:action`, (req, res) => res.json(controlStandingBatch(req.params.id, req.params.jobId, req.params.action)));
router.patch(`${base}/:slot/prompt`, (req, res) => {
  updateStandingPrompt(req.params.id, req.params.slot, req.body.prompt, req.body.generation);
  res.json({ ok: true });
});
for (const action of ['upload', 'image', 'crop', 'hires']) {
  router.post(`${base}/:slot/${action}`, async (req, res) => {
    await editStandingImage(req.params.id, req.params.slot, action, req.body);
    res.json({ ok: true });
  });
}
router.delete(`${base}/:slot`, (req, res) => { deleteStanding(req.params.id, req.params.slot); res.json({ ok: true }); });
router.get('/standing-display/state', (_req, res) => res.json(getStandingDisplay().snapshot()));
router.put('/standing-display/active', (req, res) => {
  const { characterId, clientId, sequence } = req.body;
  if (!Number.isInteger(Number(characterId)) || !getDb().prepare('SELECT id FROM characters WHERE id=?').get(characterId)) return res.status(404).json({ error: '角色不存在' });
  res.json(getStandingDisplay().select(Number(characterId), String(clientId || '').slice(0, 100), Number(sequence)));
});
export default router;
