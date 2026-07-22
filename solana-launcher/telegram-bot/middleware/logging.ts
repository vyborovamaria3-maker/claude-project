import { Middleware, Context } from 'telegraf';

export const loggingMiddleware: Middleware<Context> = async (ctx, next) => {
  const start = Date.now();
  
  console.log(`[${new Date().toISOString()}] Update from user ${ctx.from?.id || 'unknown'}: ${ctx.updateType}`);
  
  await next();
  
  const duration = Date.now() - start;
  console.log(`[${new Date().toISOString()}] Request processed in ${duration}ms`);
};
