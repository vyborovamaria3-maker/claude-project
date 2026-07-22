import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/async-handler";
import { clearAuthCookies, setAuthCookies } from "../security/cookies";
import { isRefreshTokenActive, revokeRefreshToken, signAccessToken, signRefreshToken, verifyRefreshToken } from "../security/tokens";
import { verifyTelegramLoginWidget, verifyTelegramMiniAppInitData } from "../security/telegram";
import { requireAuth } from "../middleware/auth";

const router = Router();

const telegramBodySchema = z.object({
  initData: z.string().optional(),
  loginData: z.record(z.unknown()).optional()
});

router.post(
  "/telegram",
  asyncHandler(async (req, res) => {
    const body = telegramBodySchema.parse(req.body);
    const tgUser = body.initData
      ? verifyTelegramMiniAppInitData(body.initData)
      : verifyTelegramLoginWidget(body.loginData ?? {});

    const user = await prisma.user.upsert({
      where: { telegramId: tgUser.id },
      update: {
        telegramUsername: tgUser.username,
        firstName: tgUser.firstName,
        lastName: tgUser.lastName,
        photoUrl: tgUser.photoUrl,
        lastLoginAt: new Date()
      },
      create: {
        telegramId: tgUser.id,
        telegramUsername: tgUser.username,
        firstName: tgUser.firstName,
        lastName: tgUser.lastName,
        photoUrl: tgUser.photoUrl
      },
      include: { wallets: true }
    });

    const accessToken = signAccessToken(user.id, user.telegramId);
    const refreshToken = await signRefreshToken(user.id, user.telegramId);
    const csrfToken = setAuthCookies(res, accessToken, refreshToken);
    res.json({ user, csrfToken });
  })
);

router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.refresh_token as string | undefined;
    if (!refreshToken) {
      return res.status(401).json({ error: "UNAUTHENTICATED" });
    }

    const payload = verifyRefreshToken(refreshToken);
    const active = await isRefreshTokenActive(payload.jti, payload.sub);
    if (!active) {
      return res.status(401).json({ error: "REFRESH_TOKEN_REVOKED" });
    }

    await revokeRefreshToken(payload.jti);
    const accessToken = signAccessToken(payload.sub, payload.telegramId);
    const nextRefreshToken = await signRefreshToken(payload.sub, payload.telegramId);
    const csrfToken = setAuthCookies(res, accessToken, nextRefreshToken);
    res.json({ ok: true, csrfToken });
  })
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.refresh_token as string | undefined;
    if (refreshToken) {
      try {
        const payload = verifyRefreshToken(refreshToken);
        await revokeRefreshToken(payload.jti);
      } catch {
        // A malformed refresh token still gets cleared from the browser.
      }
    }
    clearAuthCookies(res);
    res.json({ ok: true });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.session!.userId },
      include: { wallets: true }
    });
    res.json({ user });
  })
);

export default router;
