/**
 * Better Auth flow helpers for integration tests.
 *
 * Wraps the in-process HTTP client with the sign-up / sign-in / session
 * sequence, and pulls the session cookie out of the `Set-Cookie` headers that
 * Better Auth returns so tests can replay authenticated requests.
 */
import type { Elysia } from "elysia";
import { http, type HttpResult } from "./http";

const SESSION_TOKEN_COOKIE = "better-auth.session_token";

export interface SignUpOpts {
  email: string;
  password: string;
  name: string;
}

/** Unique email so repeated runs don't trip the UNIQUE email index. */
export function randomEmail(prefix = "ops"): string {
  return `${prefix}+${Math.random().toString(36).slice(2, 10)}@tie.test`;
}

export function signUp(app: Elysia, opts: SignUpOpts): Promise<HttpResult> {
  return http(app, "POST", "/api/auth/sign-up/email", { body: opts });
}

export function signIn(
  app: Elysia,
  opts: { email: string; password: string },
): Promise<HttpResult> {
  return http(app, "POST", "/api/auth/sign-in/email", { body: opts });
}

export function getSession(
  app: Elysia,
  cookie: string,
): Promise<HttpResult> {
  return http(app, "GET", "/api/auth/get-session", { cookie });
}

/** Extract `better-auth.session_token=...` from Set-Cookie headers for replay. */
export function sessionCookie(setCookies: string[]): string | undefined {
  const setCookie = setCookies.find((c) => c.startsWith(`${SESSION_TOKEN_COOKIE}=`));
  if (!setCookie) return undefined;
  return setCookie.split(";")[0];
}