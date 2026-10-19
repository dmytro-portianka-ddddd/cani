import type { Books, CommittedPayment, LedgerRow } from "./schema";
import { round2 } from "./money";

/** Parse an ISO date/datetime to an instant. All window math is on instants,
 * never on string comparison — an offset timestamp belongs to the month of
 * the instant it denotes, not the month its text happens to start with. */
export function parseInstant(value: string, field = "datetime"): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO ${field}: "${value}"`);
  return ms;
}

/** The headroom window is the calendar month (UTC) containing the ask (open
 * decision #2 in SPEC.md — per month is the recorded leaning). */
export type MonthWindow = { start: string; end: string; label: string };

export function monthWindow(atIso: string): MonthWindow {
  const at = new Date(parseInstant(atIso, "datetime"));
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
  };
}

function inWindow(atIso: string, w: MonthWindow): boolean {
  const ms = parseInstant(atIso, "datetime");
  return ms >= parseInstant(w.start) && ms < parseInstant(w.end);
}

/** Normalize a committed payment to its monthly weight: annual bills
 * annualize in (÷ 12), weekly bills convert (× 52 ÷ 12). */
function committedMonthlyAmount(p: CommittedPayment): number {
  switch (p.cadence) {
    case "monthly":
      return p.amount;
    case "weekly":
      return round2((p.amount * 52) / 12);
    case "annual":
      return round2(p.amount / 12);
  }
}

/** Loan end-dates auto-release: a payment whose end instant is before the
 * window started is out of committed — headroom widens on its own. A payment
 * ending at or inside the window stays booked for the whole window
 * (conservative: err toward more committed, never toward a wrong YES). */
function isReleased(p: CommittedPayment, w: MonthWindow): boolean {
  return p.endDate !== null && parseInstant(p.endDate, "date") < parseInstant(w.start);
}

/** Only human-confirmed payments have teeth. A missing or unparseable
 * confirmedAt is not confirmation — the payment does not count. */
function isConfirmed(p: CommittedPayment): boolean {
  return typeof p.confirmedAt === "string" && !Number.isNaN(Date.parse(p.confirmedAt));
}

/** An obligation counts once it has begun. Annual bills always count (they
 * accrue monthly toward a known due date); monthly/weekly payments count
 * when their next due date falls on or before the window's end — a loan
 * whose first payment is months away is not yet committed. */
function hasBegun(p: CommittedPayment, w: MonthWindow): boolean {
  if (p.cadence === "annual") return true;
  return parseInstant(p.nextDue, "date") <= parseInstant(w.end);
}

export type CommittedEntry = {
  id: string;
  label: string;
  monthly: number;
  amount: number;
  cadence: CommittedPayment["cadence"];
  nextDue: string;
  endDate: string | null;
  confirmedAt: string;
  source: CommittedPayment["source"];
};

export type HeadroomReport = {
  window: MonthWindow;
  income: number;
  committed: { total: number; entries: CommittedEntry[] };
  variableSpent: number;
  headroom: number;
  /** Full copies of the ledger rows counted above — the inputs snapshot a
   * decision needs to be reproduced exactly, not just summarized. */
  ledgerRows: LedgerRow[];
};

function isSpendRow(r: LedgerRow): boolean {
  return r.type === "variable_spend" || (r.type === "checkout" && r.result !== "declined");
}

/**
 * headroom = income − committed − variable spent, over the month window.
 *
 * - income: deposit rows in the window.
 * - committed: normalized from committed_payments (NOT from
 *   committed_payment ledger rows — those are history; counting both would
 *   double-book). The books are the source of truth for committed, and only
 *   active, human-confirmed, begun, unreleased payments count.
 * - variable spent: variable_spend rows + EXECUTED checkout rows. Declined
 *   checkout attempts moved no money and never decrement headroom.
 * - paypal_funding rows are transfers into envelopes, not income and not
 *   spend — they move money within the household, so they never touch
 *   headroom (they drive derived envelope balances instead).
 */
export function headroomReport(books: Books, atIso: string): HeadroomReport {
  const w = monthWindow(atIso);
  const incomeRows = books.ledger.filter((r) => r.type === "deposit" && inWindow(r.at, w));
  const income = incomeRows.reduce((s, r) => round2(s + r.amount), 0);
  const entries = books.committed
    .filter((p) => p.status === "active" && isConfirmed(p) && !isReleased(p, w) && hasBegun(p, w))
    .map((p) => ({
      id: p.id,
      label: p.label,
      monthly: committedMonthlyAmount(p),
      amount: p.amount,
      cadence: p.cadence,
      nextDue: p.nextDue,
      endDate: p.endDate,
      confirmedAt: p.confirmedAt,
      source: p.source,
    }));
  const committedTotal = entries.reduce((s, e) => round2(s + e.monthly), 0);
  const spendRows = books.ledger.filter((r) => isSpendRow(r) && inWindow(r.at, w));
  const variableSpent = spendRows.reduce((s, r) => round2(s + r.amount), 0);
  return {
    window: w,
    income,
    committed: { total: committedTotal, entries },
    variableSpent,
    headroom: round2(income - committedTotal - variableSpent),
    ledgerRows: [...incomeRows, ...spendRows].map((r) => ({ ...r })),
  };
}

/** Spend rows for a window — shared by report + future UI surfaces. Only
 * rows that moved money out as variable spend (declined checkouts excluded). */
export function windowSpendRows(books: Books, atIso: string): LedgerRow[] {
  const w = monthWindow(atIso);
  return books.ledger.filter((r) => isSpendRow(r) && inWindow(r.at, w));
}
