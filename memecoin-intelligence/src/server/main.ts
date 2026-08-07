import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from '@/server/config/env.js';
import { registerRoutes } from '@/server/api/routes.js';
import { pool } from '@/server/db/pool.js';
import { closeCache } from '@/server/cache/redis.js';
import { closeQueues } from '@/server/workers/queues.js';
import { securityHeadersOptions } from '@/server/security/headers.js';

const app = Fastify({ logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' }, bodyLimit: 5_000_000 });
await app.register(cors, { origin: env.WEB_ORIGIN.split(',').map((v) => v.trim()), credentials: false });
await app.register(helmet, securityHeadersOptions({ strict: env.SECURITY_HEADERS_STRICT, nodeEnv: env.NODE_ENV }));
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
app.setErrorHandler((error, _request, reply) => {
  const candidateStatus = (error as { statusCode?: unknown }).statusCode;
  const status = typeof candidateStatus === 'number' && candidateStatus < 500 ? candidateStatus : 500;
  const message = error instanceof Error ? error.message : 'Request failed';
  app.log.error(error);
  reply.status(status).send({ error: status === 500 ? 'Internal server error' : message });
});
await registerRoutes(app);

const shutdown = async () => { await app.close(); await closeQueues(); await closeCache(); await pool.end(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
await app.listen({ port: env.PORT, host: '0.0.0.0' });
