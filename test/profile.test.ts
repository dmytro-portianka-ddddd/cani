import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../src/decide";
import { analyzeBypasses, decideWithProfile, goalImpactText, profileAdjustment, profileInsight, STATES, stateByCode } from "../src/profile";
import { createApp } from "../src/server";
import type { Books, Profile } from "../src/schema";

const AT = "2026-06-15T19:04:00.000Z";
const books: Books = {
  committed: [
    { id: "mortgage", label: "Mortgage", amount: 1200, cadence: "monthly", nextDue: "2026-07-01", endDate: null, source: "user", confirmedAt: "2026-06-01T00:00:00.000Z", status: "active" },
    { id: "daycare", label: "Daycare", amount: 423, cadence: "monthly", nextDue: "2026-07-01", endDate: null, source: "user", confirmedAt: "2026-06-01T00:00:00.000Z", status: "active" },
    { id: "honda", label: "Honda", amount: 777, cadence: "monthly", nextDue: "2026-07-01", endDate: null, source: "user", confirmedAt: "2026-06-01T00:00:00.000Z", status: "active" },
  ],
  ledger: [
    { id: "salary", at: "2026-06-01T09:00:00.000Z", type: "deposit", amount: 8900, label: "paycheck" },
    { id: "v1", at: AT, type: "variable_spend", amount: 3800 },
    { id: "v2", at: AT, type: "variable_spend", amount: 800 },
  ],
};

const established: Profile = { ageBand: "50s", housing: "paid-off", dependents: "none", familyStatus: "single", adjustmentEnabled: true, securityDial: 50, enjoyDial: 75, familyDial: 50, goal: "enjoy-now", horizon: "this-year", temperament: "live-a-little", state: "MS" };
const loadedFamily: Profile = { ageBand: "30s-40s", housing: "mortgage", dependents: "kids-daycare", familyStatus: "married-stay-home", adjustmentEnabled: true, securityDial: 20, enjoyDial: 50, familyDial: 20, goal: "retire-well", horizon: "10-plus-years", temperament: "live-a-little", state: "CA" };

describe("bundled state data", () => {
  test("all 50 states + DC, each with cost fields", () => {
    expect(STATES.length).toBe(51);
    expect(stateByCode("CA")?.colIndex).toBeGreaterThan(stateByCode("MS")?.colIndex ?? 0);
    expect(stateByCode("XX")).toBeUndefined();
  });
});

describe("deeper mode adjustments", () => {
  test("established & mortgage-free in a cheap state earns positive flexibility", () => {
    const raw = decide({ amount: 1, label: "x", at: AT }, books);
    const adj = profileAdjustment(established, raw.inputs, stateByCode("MS")!);
    expect(adj.total).toBeGreaterThan(0);
    expect(adj.components.length).toBeGreaterThanOrEqual(3);
  });

  test("mortgage + daycare + expensive state demands a reserve", () => {
    const raw = decide({ amount: 1, label: "x", at: AT }, books);
    const adj = profileAdjustment(loadedFamily, raw.inputs, stateByCode("CA")!);
    expect(adj.total).toBeLessThan(0);
  });

  test("a marginal NO can flip in deeper mode — with the raw verdict on the record", () => {
    // books headroom is 1900; a $2,100 ask is a raw NO.
    const raw = decide({ amount: 2100, label: "deck", at: AT }, books);
    expect(raw.verdict).toBe("NO");
    const deeper = decideWithProfile({ amount: 2100, label: "deck", at: AT }, books, [], established, stateByCode("MS")!);
    expect(deeper.adjustment?.rawVerdict).toBe("NO");
    expect(deeper.adjustment?.total).toBeGreaterThanOrEqual(200);
    expect(deeper.verdict).toBe("YES");
    expect(deeper.reasons.join(" ")).toContain("books alone said NO");
    // Core decide() is untouched by all of this.
    expect(decide({ amount: 2100, label: "deck", at: AT }, books).verdict).toBe("NO");
  });

  test("insight names the archetype and locates the headroom", () => {
    const raw = decide({ amount: 1, label: "x", at: AT }, books);
    const insight = profileInsight(loadedFamily, raw.inputs, stateByCode("CA")!);
    expect(insight.archetype).toBe("Family builder under load");
    expect(insight.locationAdjustedHeadroom).toBeLessThan(raw.headroomAtTime);
    expect(insight.suggestedBufferMonths).toBe(6);
  });
});

describe("profile API", () => {
  const dir = mkdtempSync(join(tmpdir(), "cani-profile-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const req = (path: string, init?: RequestInit) => app.fetch(new Request(`http://cani.test${path}`, init));
  const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("saving a profile turns on deeper asks; bad profiles are refused", async () => {
    expect((await req("/api/profile", put({ ...established, state: "XX" }))).status).toBe(400);
    expect((await req("/api/profile", put({ ageBand: "50s" }))).status).toBe(400);
    const saved = await req("/api/profile", put(established));
    expect(saved.status).toBe(200);
    const ask = await req("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 2100, label: "deck" }) });
    const body = (await ask.json()) as { decision: { verdict: string; adjustment?: { rawVerdict: string } } };
    // Same books in the other suites say NO at $2,100-equivalent margins;
    // deeper mode must at least carry the adjustment on the record.
    expect(body.decision.adjustment?.rawVerdict).toBeDefined();
    const states = (await (await req("/api/states")).json()) as { states: unknown[] };
    expect(states.states.length).toBe(51);
  });
});

describe("profiles saved by older app versions still load", () => {
  test("missing familyStatus and dials default instead of failing", async () => {
    const { ProfileSchema } = await import("../src/schema");
    const legacy = ProfileSchema.parse({
      ageBand: "50s", housing: "paid-off", dependents: "none",
      goal: "enjoy-now", horizon: "this-year", temperament: "live-a-little", state: "MS",
    });
    expect(legacy.familyStatus).toBe("other");
    expect(legacy.securityDial).toBe(50);
    expect(legacy.enjoyDial).toBe(50);
    expect(legacy.familyDial).toBe(50);
  });
});

describe("goal damage + pattern tracking", () => {
  test("a bypass is priced in months of goal delay", () => {
    const raw = decide({ amount: 1, label: "x", at: AT }, books);
    const text = goalImpactText(1900, raw.inputs, established);
    expect(text).toContain("about 1 month");
    expect(text).toContain("experiences you planned");
  });

  test("one bypass is human; four across months is systematic and moves the goal", () => {
    const raw = decide({ amount: 1, label: "x", at: AT }, books);
    const one = [{ at: AT, amount: 500, bypass: { category: "manual" } }];
    expect(analyzeBypasses(one, AT, raw.inputs, loadedFamily).pattern).toBe("one-off");
    const many = [
      { at: "2026-04-10T00:00:00.000Z", amount: 900, bypass: { category: "manual" } },
      { at: "2026-05-10T00:00:00.000Z", amount: 900, bypass: { category: "manual" } },
      { at: "2026-06-01T00:00:00.000Z", amount: 900, bypass: { category: "manual" } },
      { at: "2026-06-10T00:00:00.000Z", amount: 900, bypass: { category: "manual" } },
    ];
    const health = analyzeBypasses(many, AT, raw.inputs, loadedFamily);
    expect(health.pattern).toBe("systematic");
    expect(health.monthsWithBypasses).toBe(3);
    expect(health.suggestedHorizon).toBe(null); // already at the longest horizon
    const short = analyzeBypasses(many, AT, raw.inputs, { ...loadedFamily, horizon: "this-year" });
    expect(short.suggestedHorizon).toBe("3-5-years");
    expect(short.verdict).toContain("systematic");
  });
});

describe("books-only mode (the contradiction killer)", () => {
  test("adjustment off: deeper verdict equals the books verdict, openly", () => {
    const off = decideWithProfile(
      { amount: 2100, label: "deck", at: AT }, books, [],
      { ...established, adjustmentEnabled: false }, stateByCode("MS")!,
    );
    expect(off.verdict).toBe("NO");
    expect(off.adjustment?.total).toBe(0);
    expect(off.reasons.join(" ")).toContain("books decide alone");
  });
});
