/**
 * Identity pillar — Better Auth HTTP surface for Elysia.
 *
 * `createIdentity` exposes a Better Auth instance's fetch handler under its
 * default `/api/auth` base path. Routes forward the raw `Request` untouched so
 * Better Auth can match its own base path, parse cookies, and read the body.
 * (Elysia's `.mount()` rewrites the URL by stripping the matched prefix, which
 * would break that matching.)
 */
import { Elysia } from "elysia";
import type { Auth } from "./auth";

export function createIdentity(auth: Auth) {
  return new Elysia({ name: "auth.identity" })
    .all(
      "/api/auth",
      { parse: "none" },
      ({ request }) => auth.handler(request),
    )
    .all(
      "/api/auth/*",
      { parse: "none" },
      ({ request }) => auth.handler(request),
    );
}

export { createSessionAuth } from "./session";
export { createAuth } from "./auth";
export type { Auth, Session } from "./auth";
