import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cartCheck, classifyCartItem, classifyMerchant, decideAsk, DEFAULT_ESSENTIALS } from "../src/essentials";
import { createApp } from "../src/server";
import type { Books } from "../src/schema";

const AT = "2026-06-15T19:04:00.000Z";
const books: Books = {
  committed: [],
  ledger: [{ id: "s", at: "2026-06-01T09:00:00.000Z", type: "deposit", amount: 100, label: "paycheck" }],
};
// Headroom is $100: a $120 ask is a books NO.

describe("essential lane classification", () => {
  test("CVS is pharmacy, Shell is fuel, Kroger is groceries, Best Buy is nothing", () => {
    expect(classifyMerchant("CVS Pharmacy")).toBe("pharmacy");
    expect(classifyMerchant("Shell")).toBe("fuel");
    expect(classifyMerchant("Kroger")).toBe("groceries");
    expect(classifyMerchant("Best Buy")).toBe(null);
    expect(classifyMerchant(undefined)).toBe(null);
  });

  test("beer and candy are not essential; milk and eggs are", () => {
    expect(classifyCartItem("IPA Beer 6-pack").essential).toBe(false);
    expect(classifyCartItem("Chocolate Bar").kind).toBe("sweets & treats");
    expect(classifyCartItem("Whole Milk").essential).toBe(true);
    expect(classifyCartItem("Eggs").essential).toBe(true);
  });
});

describe("decideAsk — the lane", () => {
  test("medicine over headroom but under the cap rides free, raw verdict on record", () => {
    const d = decideAsk({ amount: 120, label: "insulin", merchant: "CVS Pharmacy", at: AT }, books, [], DEFAULT_ESSENTIALS);
    expect(d.verdict).toBe("YES");
    expect(d.bypass?.category).toBe("pharmacy");
    expect(d.bypass?.rawVerdict).toBe("NO");
  });

  test("over the cap, the normal engine decides", () => {
    const d = decideAsk({ amount: 600, label: "big shop", merchant: "Kroger", at: AT }, books, [], DEFAULT_ESSENTIALS);
    expect(d.verdict).toBe("NO");
    expect(d.bypass).toBeUndefined();
  });

  test("a cart with beer in it does not ride, and the beer is named", () => {
    const items = [
      { name: "Milk", amount: 50 },
      { name: "Beer", amount: 70 },
    ];
    const d = decideAsk({ amount: 120, label: "groceries", merchant: "Kroger", items, at: AT }, books, [], DEFAULT_ESSENTIALS);
    expect(d.verdict).toBe("NO");
    expect(d.reasons.join(" ")).toContain("Beer");
    expect(d.reasons.join(" ")).toContain("alcohol");
  });

  test("an all-essential cart rides, checked by the built-in reader", () => {
    const items = [
      { name: "Milk", amount: 60 },
      { name: "Eggs", amount: 60 },
    ];
    const d = decideAsk({ amount: 120, label: "groceries", merchant: "Kroger", items, at: AT }, books, [], DEFAULT_ESSENTIALS);
    expect(d.verdict).toBe("YES");
    expect(d.reasons.join(" ")).toContain("cart verified all-essential");
    const check = cartCheck(items, 120);
    expect(check.nonEssential).toEqual([]);
  });
});

describe("shame-priced manual bypass (API)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cani-shame-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const req = (path: string, init?: RequestInit) => app.fetch(new Request(`http://cani.test${path}`, init));
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const askDeck = () => req("/api/ask", post({ amount: 2800, label: "Aeron Deck" }));

  test("first NO has no bypass; second NO unlocks it; using it costs escalating shame", async () => {
    const first = (await (await askDeck()).json()) as { decision: { verdict: string; bypassAvailable?: boolean } };
    expect(first.decision.verdict).toBe("NO");
    expect(first.decision.bypassAvailable).toBeUndefined();
    expect((await req("/api/ask/manual-bypass", post({ amount: 2800, label: "Aeron Deck" }))).status).toBe(409);

    const second = (await (await askDeck()).json()) as { decision: { bypassAvailable?: boolean } };
    expect(second.decision.bypassAvailable).toBe(true);

    const bypassed = (await (await req("/api/ask/manual-bypass", post({ amount: 2800, label: "Aeron Deck" }))).json()) as {
      decision: { verdict: string; bypass?: { shameAwarded?: number; rawVerdict: string } };
      shame: { points: number };
    };
    expect(bypassed.decision.verdict).toBe("YES");
    expect(bypassed.decision.bypass?.shameAwarded).toBe(1);
    expect((bypassed.decision as { goalImpact?: string }).goalImpact).toContain("moves that far away");
    expect(bypassed.decision.bypass?.rawVerdict).toBe("NO");
    expect(bypassed.shame.points).toBe(1);

    // Essentials never shame: a CVS ask under the cap is a clean YES.
    const meds = (await (await req("/api/ask", post({ amount: 60, label: "insulin", merchant: "CVS Pharmacy" }))).json()) as {
      decision: { verdict: string; bypass?: { category: string } };
    };
    expect(meds.decision.verdict).toBe("YES");
    expect(meds.decision.bypass?.category).toBe("pharmacy");
  });
});
