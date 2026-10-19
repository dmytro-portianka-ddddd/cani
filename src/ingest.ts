import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Level 2 — "show us your typical month". Parses a bank-style CSV
 * (date,description,amount; income positive, spend negative) and PROPOSES
 * books: totals plus committed-payment candidates. Nothing here writes
 * anything; the server applies a proposal only after the human confirms
 * candidates (see /api/ingest/apply), and ledger rows land through the
 * same validated appendRow as everything else.
 */

export type CsvRow = { date: string; description: string; amount: number };

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("CSV needs a header and at least one row");
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const header = splitLine(lines[0]!).map((h) => h.toLowerCase());
  const dateIdx = header.findIndex((h) => h.includes("date"));
  const descIdx = header.findIndex((h) => h.includes("desc") || h.includes("name") || h.includes("merchant") || h.includes("payee"));
  const amountIdx = header.findIndex((h) => h === "amount" || h.includes("amount") || h.includes("value"));
  if (dateIdx < 0 || descIdx < 0 || amountIdx < 0) {
    throw new Error("CSV header must include date, description, and amount columns");
  }
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!);
    const amount = Number((cells[amountIdx] ?? "").replace(/[$,]/g, ""));
    const date = cells[dateIdx] ?? "";
    const description = cells[descIdx] ?? "";
    if (!description || Number.isNaN(amount) || Number.isNaN(Date.parse(date))) {
      throw new Error(`CSV line ${i + 1}: needs a parseable date, a description, and a numeric amount`);
    }
    rows.push({ date: new Date(Date.parse(date)).toISOString(), description, amount: Math.round(amount * 100) / 100 });
  }
  return rows;
}

const COMMITTED_HINTS = [
  "mortgage", "rent", "daycare", "childcare", "loan", "insurance", "tuition",
  "car payment", "auto pay", "subscription", "netflix", "spotify", "gym",
  "hoa", "utility", "electric", "water", "internet", "phone",
];

export type MonthProposal = {
  rowCount: number;
  income: number;
  variableSpent: number;
  candidates: { label: string; amount: number; cadence: "monthly"; hint: string }[];
  rows: CsvRow[];
};

export function proposeMonth(rows: CsvRow[]): MonthProposal {
  let income = 0;
  let variableSpent = 0;
  const candidates = new Map<string, { label: string; amount: number; hint: string }>();
  for (const row of rows) {
    if (row.amount > 0) { income = Math.round((income + row.amount) * 100) / 100; continue; }
    const spend = Math.abs(row.amount);
    const lower = row.description.toLowerCase();
    const hint = COMMITTED_HINTS.find((h) => lower.includes(h));
    if (hint) {
      const key = `${lower}|${spend}`;
      if (!candidates.has(key)) {
        candidates.set(key, { label: row.description, amount: spend, hint });
      }
    } else {
      variableSpent = Math.round((variableSpent + spend) * 100) / 100;
    }
  }
  return {
    rowCount: rows.length,
    income,
    variableSpent,
    candidates: [...candidates.values()].map((c) => ({ ...c, cadence: "monthly" as const })),
    rows,
  };
}

/** Deterministic row id — re-applying the same month is a no-op, because
 * appendRow refuses duplicate ids. */
export function ingestRowId(row: CsvRow): string {
  return `ingest-${createHash("sha256").update(`${row.date}|${row.description}|${row.amount}`).digest("hex").slice(0, 16)}`;
}

export const IngestApplySchema = z
  .object({
    rows: z.array(z.object({ date: z.string().min(1), description: z.string().min(1).max(120), amount: z.number().finite() })).max(500),
    confirmCandidateIndexes: z.array(z.number().int().min(0)).max(50),
  })
  .strict();

export const CsvUploadSchema = z.object({ csv: z.string().min(1).max(200_000) }).strict();
