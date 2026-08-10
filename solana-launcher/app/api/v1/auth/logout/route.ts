import { NextResponse } from "next/server";

const SESSION_COOKIE = "potapoff_access_token";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
