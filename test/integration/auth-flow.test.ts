import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createApp } from "../../src/app";
import { createTestDb, isSurrealAvailable } from "../helpers/db";
import {
  getSession,
  randomEmail,
  sessionCookie,
  signIn,
  signUp,
} from "../helpers/auth";
import { http } from "../helpers/http";

const reachable = await isSurrealAvailable();

describe.skipIf(!reachable)("auth flow (integration)", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const testDb = await createTestDb();
    app = createApp(testDb.db);
    close = testDb.close;
  });

  afterAll(async () => {
    await close?.();
  });

  it("serves the health endpoint", async () => {
    const res = await http(app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok" });
  });

  it("exposes the Better Auth ok endpoint", async () => {
    const res = await http(app, "GET", "/api/auth/ok");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  });

  it("gates /console/me behind a session (401 problem envelope)", async () => {
    const res = await http(app, "GET", "/console/me");
    expect(res.status).toBe(401);
    expect((res.json as { type: string }).type).toBe("urn:tie:problem:unauthenticated");
  });

  it("signs up, returns a valid session cookie, and gates console behind it", async () => {
    const email = randomEmail();
    const up = await signUp(app, {
      email,
      password: "SuperSecret123!",
      name: "Ops User",
    });
    expect(up.status).toBe(200);

    const cookie = sessionCookie(up.setCookies);
    expect(cookie).toBeDefined();

    const me = await http(app, "GET", "/console/me", { cookie: cookie! });
    expect(me.status).toBe(200);
    expect((me.json as { user: { email: string } }).user.email).toBe(email);
  });

  it("returns a well-formed user record id from the session", async () => {
    const email = randomEmail();
    const up = await signUp(app, { email, password: "SuperSecret123!", name: "Board" });
    const cookie = sessionCookie(up.setCookies);
    expect(cookie).toBeDefined();

    const session = await getSession(app, cookie!);
    expect(session.status).toBe(200);

    const user = (session.json as { user: { id: string } }).user;
    // Better Auth generates the id; the adapter round-trips it as a plain
    // string (never mangled to a record-id shape or an empty object).
    expect(user.id).toMatch(/^[\w-]{20,}$/);
    expect(user.id).not.toMatch(/[{} :]/);
    expect(user.email).toBe(email);
  });

  it("serializes datetimes as ISO strings, not empty objects", async () => {
    const email = randomEmail();
    const up = await signUp(app, { email, password: "SuperSecret123!", name: "Timestamps" });
    const cookie = sessionCookie(up.setCookies);
    expect(cookie).toBeDefined();

    const session = await getSession(app, cookie!);
    expect(session.status).toBe(200);
    const json = session.json as {
      user: { createdAt: string };
      session: { expiresAt: string };
    };
    expect(new Date(json.user.createdAt).getTime()).not.toBeNaN();
    expect(new Date(json.session.expiresAt).getTime()).not.toBeNaN();
  });

  it("signs an existing user back in", async () => {
    const email = randomEmail();
    expect((await signUp(app, { email, password: "SuperSecret123!", name: "Repeat" })).status).toBe(200);

    const inAgain = await signIn(app, { email, password: "SuperSecret123!" });
    expect(inAgain.status).toBe(200);
    expect(sessionCookie(inAgain.setCookies)).toBeDefined();
  });
});