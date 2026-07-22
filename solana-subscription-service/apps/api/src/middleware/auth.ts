import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/errors";
import { verifyAccessToken } from "../security/tokens";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.access_token as string | undefined;
    if (!token) {
      throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    }

    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new AppError(401, "User does not exist", "UNAUTHENTICATED");
    }

    req.user = user;
    req.session = { userId: user.id, telegramId: user.telegramId };
    next();
  } catch {
    next(new AppError(401, "Invalid or expired access token", "UNAUTHENTICATED"));
  }
}

export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const cookieToken = req.cookies?.csrf_token as string | undefined;
  const headerToken = req.header("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return next(new AppError(403, "CSRF token mismatch", "CSRF_MISMATCH"));
  }
  return next();
}
