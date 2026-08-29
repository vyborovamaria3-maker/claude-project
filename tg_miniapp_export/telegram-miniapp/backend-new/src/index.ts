import express from 'express';
import cors from 'cors';
import { config, validateConfig } from './config';
import { createPaymentHandler, getSubscriptionStatus } from './controllers/subscriptionController';
import { handleHeliusWebhook, webhookHealth } from './controllers/webhookController';

// Validate config on startup
try {
  validateConfig();
} catch (error) {
  console.error('Config validation failed:', error);
  process.exit(1);
}

const app = express();

// Middleware
app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.post('/api/subscription/create', createPaymentHandler);
app.get('/api/subscription/status', getSubscriptionStatus);

// Webhook Routes
app.post('/webhook/helius', handleHeliusWebhook);
app.get('/webhook/helius/health', webhookHealth);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Express error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Start server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Frontend URL: ${config.frontendUrl}`);
  console.log(`💰 Merchant wallet: ${config.merchantWallet.slice(0, 12)}...`);
  console.log(`🌐 Webhook endpoint: http://localhost:${PORT}/webhook/helius`);
});

export default app;
