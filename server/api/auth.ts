/**
 * Authentication API
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const router = express.Router();
const SECRET = process.env.BETTER_AUTH_SECRET || crypto.randomBytes(32).toString('hex');

router.post('/register', (req, res) => {
  const { email } = req.body;
  const userId = crypto.randomUUID();
  const token = jwt.sign({ userId, email }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: userId, email } });
});

router.post('/login', (req, res) => {
  const { email } = req.body;
  const userId = crypto.randomUUID();
  const token = jwt.sign({ userId, email }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: userId, email } });
});

router.post('/logout', (req, res) => {
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, SECRET) as any;
    res.json({ user: decoded });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
