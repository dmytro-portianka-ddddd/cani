import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRow, envelopeBalances, loadLedger } from "../src/ledger";
import type { LedgerRow } from "../src/schema";

const dir = mkdtempSync(join(tmpdir(), "cani-ledger-"));
const path = join(dir, "ledger.jsonl");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return { id: "r", at: "2026-06-15T19:04:00.000Z", type: "variable_spend", amount: 1, ...overrides };
}

describe("the append-only ledger", () => {
  test("rows only append — the first row stays byte-for-byte intact", () => {
    const first = appendRow(path, row({ id: "a", amount: 100 }));
    appendRow(path, row({ id: "b", amount: 50 }));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(first);
    expect(loadLedger(path).length).toBe(2);
  });

  test("a malformed row fails LOUD with its line number — never silent", () => {
    writeFileSync(path, `${JSON.stringify(row({ id: "a" }))}\n{"id": "bad"}\n`);
    expect(() => loadLedger(path)).toThrow(/line 2: malformed row/);
  });

  test("a line that is not JSON fails loud, too", () => {
    writeFileSync(path, "not json at all\n");
    expect(() => loadLedger(path)).toThrow(/line 1: not valid JSON/);
  });

  test("a missing file is an empty ledger, not an error", () => {
    expect(loadLedger(join(dir, "nope.jsonl"))).toEqual([]);
  });
});

describe("envelope balances are derived, never written", () => {
  test("funding in − executed checkouts out; declined attempts never count", () => {
    const rows = [
      row({ id: "f1", type: "paypal_funding", amount: 500, envelope: "deck", orderId: "PAY-1" }),
      row({ id: "f2", type: "paypal_funding", amount: 200, envelope: "deck", orderId: "PAY-2" }),
      row({ id: "c1", type: "checkout", amount: 300, envelope: "deck", orderId: "PAY-3", result: "executed" }),
      row({ id: "c2", type: "checkout", amount: 250, envelope: "deck", orderId: "PAY-4", result: "declined" }),
      row({ id: "f3", type: "paypal_funding", amount: 999, envelope: "kitchen", orderId: "PAY-5" }),
    ];
    const balances = envelopeBalances(rows);
    expect(balances.get("deck")).toBe(400); // 500 + 200 − 300; declined 250 excluded
    expect(balances.get("kitchen")).toBe(999);
  });
});

describe("the ledger refuses bad writes (regressions from code review)", () => {
  test("appendRow validates before writing and refuses duplicate ids", () => {
    const p = join(dir, "append.jsonl");
    appendRow(p, row({ id: "a", amount: 10 }));
    expect(() => appendRow(p, row({ id: "a", amount: 99 }))).toThrow(/duplicate ledger row id/);
    expect(() => appendRow(p, row({ id: "b", amount: -5 }))).toThrow(/malformed ledger row/);
    expect(loadLedger(p).length).toBe(1);
  });

  test("a duplicated row inside the file fails loud on load", () => {
    const p = join(dir, "dup.jsonl");
    const line = JSON.stringify(row({ id: "a" }));
    writeFileSync(p, `${line}\n${line}\n`);
    expect(() => loadLedger(p)).toThrow(/duplicate row id/);
  });

  test("envelope balances are cents-exact", () => {
    const balances = envelopeBalances([
      row({ id: "f1", type: "paypal_funding", amount: 0.1, envelope: "e" }),
      row({ id: "f2", type: "paypal_funding", amount: 0.2, envelope: "e" }),
    ]);
    expect(balances.get("e")).toBe(0.3);
  });
});
