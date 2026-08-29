import { Middleware, Context } from 'telegraf';

interface SessionData {
  selectedAgent?: string;
  [key: string]: any;
}

declare module 'telegraf' {
  interface Context {
    session?: SessionData;
  }
}

export const sessionMiddleware: Middleware<Context> = async (ctx, next) => {
  if (!ctx.session) {
    ctx.session = {};
  }
  await next();
};
