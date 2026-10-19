import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../src/decide";
import { appendDecision, loadDecisions } from "../src/decisions";
import type { Books } from "../src/schema";

const dir = mkdtempSync(join(tmpdir(), "cani-decisions-"));
const path = join(dir, "decisions.jsonl");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const books: Books = {
  committed: [],
  ledger: [{ id: "s", at: "2026-06-01T09:00:00.000Z", type: "deposit", amount: 1000, label: "paycheck" }],
};

describe("the decisions store (audit trail)", () => {
  test("a verdict round-trips with its inputs snapshot and engine version", () => {
    const d = decide({ amount: 2800, label: "Aeron Deck", at: "2026-06-15T19:04:00.000Z" }, books);
    appendDecision(path, d);
    const loaded = loadDecisions(path);
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.verdict).toBe("NO");
    expect(loaded[0]?.engineVersion).toBe(d.engineVersion);
    expect(loaded[0]?.inputs.ledgerRows.map((r) => r.id)).toEqual(["s"]);
  });

  test("a malformed decision line fails loud with its line number", () => {
    writeFileSync(path, `${JSON.stringify(decide({ amount: 1, label: "x", at: "2026-06-15T00:00:00.000Z" }, books))}\n{"nope":true}\n`);
    expect(() => loadDecisions(path)).toThrow(/line 2: malformed decision/);
  });

  test("a missing file is an empty audit trail, not an error", () => {
    expect(loadDecisions(join(dir, "nope.jsonl"))).toEqual([]);
  });
});
