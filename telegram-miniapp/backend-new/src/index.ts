import express from 'express';
import cors from 'cors';
import { config, validateConfig } from './config';
import { createPaymentHandler, getSubscriptionStatus } from './controllers/subscriptionController';
import { handleHeliusWebhook, webhookHealth } from './controllers/webhookController';

try {
  validateConfig();
} catch (error) {
  console.error('Config validation failed:', error);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
});

app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/subscription/create', createPaymentHandler);
app.get('/api/subscription/status', getSubscriptionStatus);

app.post('/webhook/helius', handleHeliusWebhook);
app.get('/webhook/helius/health', webhookHealth);

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Express error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Frontend URL: ${config.frontendUrl}`);
  console.log(`💰 Merchant wallet: ${config.merchantWallet.slice(0, 12)}...`);
  console.log(`🌐 Webhook endpoint: http://localhost:${PORT}/webhook/helius`);
});

export default app;
