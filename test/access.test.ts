import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "cani-access-"));
afterAll(() => {
  delete process.env.CANI_ACCESS_CODE;
  rmSync(dir, { recursive: true, force: true });
});
process.env.CANI_ACCESS_CODE = "demo-123";
const app = createApp(dir);
const req = (path: string, init?: RequestInit) => app.fetch(new Request(`http://cani.test${path}`, init));
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("public-demo access guard + kept counter", () => {
  test("API refuses strangers, admits the code by cookie or header", async () => {
    expect((await req("/api/state")).status).toBe(401);
    expect((await req("/api/login", post({ code: "wrong" }))).status).toBe(401);
    const login = await req("/api/login", post({ code: "demo-123" }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("cani_access=");
    expect((await req("/api/state", { headers: { cookie } })).status).toBe(200);
    expect((await req("/api/state", { headers: { "x-cani-access": "demo-123" } })).status).toBe(200);
    // The webhook stays open to PayPal (it carries its own signature).
    expect((await req("/api/paypal/webhook", post({ nope: true }))).status).toBe(400);
  });

  test("a NO banks impact: kept counter counts it until a bypass spends it back", async () => {
    const headers = { "x-cani-access": "demo-123" };
    await req("/api/ask", post({ amount: 2800, label: "Aeron Deck" }, headers));
    const state = (await (await req("/api/state", { headers })).json()) as { kept: { count: number; amount: number } };
    expect(state.kept.count).toBe(1);
    expect(state.kept.amount).toBe(2800);
  });
});
