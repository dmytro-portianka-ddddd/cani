import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv, proposeMonth } from "../src/ingest";
import { paypalStatus } from "../src/paypal";
import { createApp } from "../src/server";

const CSV = [
  "date,description,amount",
  "2026-06-01,Paycheck,3200",
  '2026-06-03,"Mortgage, First Bank",-950',
  "2026-06-05,Daycare Center,-410",
  "2026-06-07,Coffee Shop,-6.50",
].join("\n");

describe("Level 2 — typical month ingest", () => {
  test("parses quoted CSV and proposes books without writing", () => {
    const rows = parseCsv(CSV);
    expect(rows.length).toBe(4);
    expect(rows[1]?.description).toBe("Mortgage, First Bank");
    const p = proposeMonth(rows);
    expect(p.income).toBe(3200);
    expect(p.variableSpent).toBe(6.5);
    expect(p.candidates.map((c) => c.label)).toContain("Mortgage, First Bank");
    expect(p.candidates.map((c) => c.label)).toContain("Daycare Center");
  });

  test("a bad header and a bad row fail loud", () => {
    expect(() => parseCsv("a,b,c\n1,2,3")).toThrow(/header/);
    expect(() => parseCsv("date,description,amount\nnope,X,5")).toThrow(/line 2/);
  });
});

describe("Level 3 — PayPal capability check", () => {
  test("without credentials it says so, and states the limits plainly", () => {
    delete process.env.CANI_PAYPAL_CLIENT_ID;
    delete process.env.CANI_PAYPAL_CLIENT_SECRET;
    const s = paypalStatus();
    expect(s.configured).toBe(false);
    expect(s.limits.join(" ")).toContain("cannot read bank statements");
  });
});

describe("ingest API: confirm-to-apply", () => {
  const dir = mkdtempSync(join(tmpdir(), "cani-ingest-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const req = (path: string, init?: RequestInit) => app.fetch(new Request(`http://cani.test${path}`, init));
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("propose writes nothing; confirming a candidate adds it, re-applying dedupes", async () => {
    const proposalRes = await req("/api/ingest", post({ csv: CSV }));
    const { proposal } = (await proposalRes.json()) as { proposal: ReturnType<typeof proposeMonth> };
    const before = (await (await req("/api/state")).json()) as { committed: unknown[]; levels: { month: boolean } };
    expect(before.committed.length).toBe(3); // seeds only — proposal wrote nothing
    expect(before.levels.month).toBe(false);

    const mortgageIdx = proposal.candidates.findIndex((c) => c.label.startsWith("Mortgage"));
    const applied = (await (await req("/api/ingest/apply", post({ rows: proposal.rows, confirmCandidateIndexes: [mortgageIdx] }))).json()) as {
      committedAdded: string[]; appended: number; levels: { month: boolean }; committed: { label: string }[];
    };
    expect(applied.committedAdded.length).toBe(1);
    expect(applied.committed.map((c) => c.label).join(" ")).toContain("Mortgage");
    // Daycare was NOT confirmed, so it must not be in the books.
    expect(applied.committed.map((c) => c.label)).not.toContain("Daycare Center");
    expect(applied.levels.month).toBe(true);

    const again = (await (await req("/api/ingest/apply", post({ rows: proposal.rows, confirmCandidateIndexes: [mortgageIdx] }))).json()) as { appended: number; skippedDuplicates: number };
    expect(again.appended).toBe(0);
    expect(again.skippedDuplicates).toBeGreaterThan(0);
  });
});

describe("PayPal credential verification", () => {
  test("no credentials → unverifiable; a 200 token exchange → verified; a 401 → rejected", async () => {
    const { verifyPayPal } = await import("../src/paypal");
    delete process.env.CANI_PAYPAL_CLIENT_ID;
    delete process.env.CANI_PAYPAL_CLIENT_SECRET;
    expect((await verifyPayPal()).verified).toBe(null);
    process.env.CANI_PAYPAL_CLIENT_ID = "id";
    process.env.CANI_PAYPAL_CLIENT_SECRET = "secret";
    const okFetch = Object.assign(async () => new Response("{}", { status: 200 }), { preconnect: () => {} });
    expect((await verifyPayPal(okFetch)).verified).toBe(true);
    const badFetch = Object.assign(async () => new Response("{}", { status: 401 }), { preconnect: () => {} });
    expect((await verifyPayPal(badFetch)).verified).toBe(false);
    delete process.env.CANI_PAYPAL_CLIENT_ID;
    delete process.env.CANI_PAYPAL_CLIENT_SECRET;
  });
});
