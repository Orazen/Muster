/**
 * Marketplace API
 */
import express from 'express';
const router = express.Router();

router.get('/templates', (req, res) => {
  res.json({ templates: [], total: 0, page: 1 });
});

router.get('/templates/:id', (req, res) => {
  res.json({ id: req.params.id });
});

router.post('/templates/:id/reviews', (req, res) => {
  res.json({ success: true, review: req.body });
});

router.post('/templates/:id/download', (req, res) => {
  res.json({ success: true });
});

export default router;
