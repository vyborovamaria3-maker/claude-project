import type { Response } from "express";
import { nanoid } from "nanoid";
import { cookieConfig, env } from "../config/env";

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie("access_token", accessToken, {
    ...cookieConfig,
    maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000
  });
  res.cookie("refresh_token", refreshToken, {
    ...cookieConfig,
    maxAge: env.REFRESH_TOKEN_TTL_SECONDS * 1000
  });
  return setCsrfCookie(res);
}

export function setCsrfCookie(res: Response) {
  const csrf = nanoid(32);
  res.cookie("csrf_token", csrf, {
    ...cookieConfig,
    httpOnly: false,
    maxAge: env.REFRESH_TOKEN_TTL_SECONDS * 1000
  });
  return csrf;
}

export function clearAuthCookies(res: Response) {
  res.clearCookie("access_token", cookieConfig);
  res.clearCookie("refresh_token", cookieConfig);
  res.clearCookie("csrf_token", { ...cookieConfig, httpOnly: false });
}
