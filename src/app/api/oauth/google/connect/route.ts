import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { buildAuthUrl } from "@/lib/oauth/google";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const state = randomBytes(16).toString("hex");

  const response = NextResponse.redirect(buildAuthUrl(origin, state));
  response.cookies.set("google_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return response;
}
