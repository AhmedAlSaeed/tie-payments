/**
 * Session guard — Elysia plugin for human-facing (console/portal) endpoints.
 *
 * Factory over a Better Auth instance: derives the session from the request
 * cookies and injects `user`/`session` into the handler context. Routes that
 * `use` this plugin are gated — unauthenticated callers get the standard
 * RFC 9457 `unauthenticated` problem instead of a session payload.
 */
import { Elysia } from "elysia";
import type { Auth } from "./auth";
import { problem } from "../core/errors";

export function createSessionAuth(auth: Auth) {
  return new Elysia({ name: "auth.session" })
    .derive(async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) throw problem("unauthenticated", "Sign in required.");
      return { user: session.user, session: session.session };
    })
    .as("plugin");
}
