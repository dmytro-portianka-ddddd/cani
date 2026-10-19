import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "cani-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const app = createApp(dir);

function req(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://cani.test${path}`, init));
}
function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("the PWA + HTTP API", () => {
  test("the flagship ask over the API: $2,800 deck → NO, short by $900", async () => {
    const res = await req("/api/ask", post({ amount: 2800, label: "Aeron Deck" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: { verdict: string; shortBy: number; engineVersion: string } };
    expect(body.decision.verdict).toBe("NO");
    expect(body.decision.shortBy).toBe(900);
    expect(body.decision.engineVersion).toBe("0.3.0");
  });

  test("untrusted payloads are refused at the boundary, not decided", async () => {
    for (const bad of [{ amount: -5, label: "x" }, { amount: 10.005, label: "x" }, { label: "x" }, { amount: 5, label: "x", evil: true }]) {
      const res = await req("/api/ask", post(bad));
      expect(res.status).toBe(400);
    }
  });

  test("recording spend moves headroom; the audit trail keeps every verdict", async () => {
    const before = (await (await req("/api/state")).json()) as { report: { headroom: number } };
    expect(before.report.headroom).toBe(1900);
    const spent = (await (await req("/api/spend", post({ amount: 400, label: "groceries" }))).json()) as { report: { headroom: number } };
    expect(spent.report.headroom).toBe(1500);
    const decisions = (await (await req("/api/decisions")).json()) as { decisions: unknown[] };
    expect(decisions.decisions.length).toBeGreaterThanOrEqual(1);
  });

  test("the installable shell is served: html, manifest, service worker, icons", async () => {
    const html = await (await req("/")).text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain("Can I buy this?");
    const manifest = (await (await req("/manifest.webmanifest")).json()) as { display: string; icons: { sizes: string }[] };
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.map((i) => i.sizes)).toContain("512x512");
    expect((await req("/sw.js")).status).toBe(200);
    expect((await req("/icon-192.png")).status).toBe(200);
    expect((await req("/api/nope")).status).toBe(404);
  });
});
