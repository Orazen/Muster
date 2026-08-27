/**
 * API Routes Aggregator
 */
import express from 'express';
import stripeRouter from './api/stripe';
import authRouter from './api/auth';
import marketplaceRouter from './api/marketplace';

export function setupRoutes(app: express.Application) {
  app.use('/api/payments', stripeRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/marketplace', marketplaceRouter);
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });
}
