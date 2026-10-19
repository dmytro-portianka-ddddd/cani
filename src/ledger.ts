import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { LedgerRowSchema, type LedgerRow } from "./schema";
import { round2 } from "./money";

/**
 * The append-only ledger. One JSON row per line; nothing is ever edited in
 * place — corrections are new rows. Malformed rows fail LOUD (with the line
 * number) — a ledger that silently skips a bad row is a ledger that can
 * silently lose money. Duplicate row ids fail loud too: a replayed append
 * must never double-count money into headroom.
 */
export function loadLedger(path: string): LedgerRow[] {
  if (!existsSync(path)) return [];
  const rows: LedgerRow[] = [];
  const seen = new Map<string, number>();
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `ledger ${path} line ${i + 1}: not valid JSON (${(err as Error).message})`,
      );
    }
    const parsed = LedgerRowSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `ledger ${path} line ${i + 1}: malformed row (${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(", ")})`,
      );
    }
    const firstLine = seen.get(parsed.data.id);
    if (firstLine !== undefined) {
      throw new Error(
        `ledger ${path} line ${i + 1}: duplicate row id "${parsed.data.id}" (first seen on line ${firstLine})`,
      );
    }
    seen.set(parsed.data.id, i + 1);
    rows.push(parsed.data);
  }
  return rows;
}

/** Append a row. Never rewrites, never deletes — the file only grows. The
 * row is validated before it touches disk, and a duplicate id is refused:
 * appends are idempotent by id, so a retried write cannot double-count. */
export function appendRow(path: string, row: LedgerRow): LedgerRow {
  const parsed = LedgerRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      `refusing to append malformed ledger row (${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")})`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && loadLedger(path).some((r) => r.id === parsed.data.id)) {
    throw new Error(`refusing to append duplicate ledger row id "${parsed.data.id}"`);
  }
  appendFileSync(path, `${JSON.stringify(parsed.data)}\n`, "utf8");
  return parsed.data;
}

/**
 * Envelope balances are DERIVED from the ledger, never written directly:
 * funding rows in − executed checkout rows out, per envelope. Declined
 * checkouts moved no money and don't count. Rounded to cents at every step.
 */
export function envelopeBalances(rows: LedgerRow[]): Map<string, number> {
  const balances = new Map<string, number>();
  for (const row of rows) {
    if (row.type === "paypal_funding" && row.envelope !== undefined) {
      balances.set(row.envelope, round2((balances.get(row.envelope) ?? 0) + row.amount));
    }
    if (row.type === "checkout" && row.envelope !== undefined && row.result !== "declined") {
      balances.set(row.envelope, round2((balances.get(row.envelope) ?? 0) - row.amount));
    }
  }
  return balances;
}
