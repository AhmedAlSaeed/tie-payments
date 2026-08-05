/**
 * In-process HTTP client over an Elysia app.
 *
 * Exercises `app.handle(new Request(...))` directly — no bound port, no curl.
 * Returns the parsed status/body/cookies so tests assert on the envelope.
 */
import type { Elysia } from "elysia";

export interface HttpResult {
  status: number;
  json: unknown;
  text: string;
  setCookies: string[];
  headers: Headers;
}

export interface HttpOpts {
  body?: unknown;
  headers?: Record<string, string>;
  cookie?: string;
}

export async function http(
  app: Elysia,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts: HttpOpts = {},
): Promise<HttpResult> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie) headers.set("cookie", opts.cookie);

  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const res = await app.handle(request);
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return {
    status: res.status,
    json,
    text,
    setCookies: res.headers.getSetCookie(),
    headers: res.headers,
  };
}