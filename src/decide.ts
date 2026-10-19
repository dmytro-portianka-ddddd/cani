import { z } from "zod";
import { ENGINE_VERSION } from "./version";
import { headroomReport, parseInstant, type HeadroomReport } from "./headroom";
import { round2 } from "./money";
import {
  AskSchema,
  BooksSchema,
  LedgerRowSchema,
  MoneySchema,
  PlannedItemSchema,
  ProfileSchema,
  type Ask,
  type Books,
  type PlannedItem,
} from "./schema";

export type Verdict = "YES" | "NO";

/** The audit trail row — every verdict is stored, forever reproducible:
 * query, headroom at the time, reasons (the bars), the inputs snapshot
 * (full committed entries + the exact ledger rows counted), the planned
 * items considered, and the engine version that did the arithmetic. */
export type Decision = {
  at: string;
  label: string;
  amount: number;
  verdict: Verdict;
  headroomAtTime: number;
  shortBy: number | null;
  reasons: string[];
  /** The path back to YES (coaching): the smallest planned item *in this
   * window* that covers the shortfall. Deterministic, from human-entered
   * (or AI-proposed, human-confirmed) planned items — never a model's
   * opinion, and never an item from another month: skipping a past or
   * future spend frees nothing in the window being asked about. */
  pathToYes: string | null;
  planned: PlannedItem[];
  inputs: HeadroomReport;
  engineVersion: string;
  /** Deeper mode only (profile.ts): the open, line-item profile adjustment.
   * Core decisions never carry this. rawVerdict is what the books alone
   * said — both verdicts stay on the record whenever they differ. */
  adjustment?: {
    components: { label: string; amount: number }[];
    total: number;
    adjustedHeadroom: number;
    rawVerdict: Verdict;
    profile: import("./schema").Profile;
    state: { code: string; name: string; colIndex: number };
  };
  /** Essential-lane bypass (essentials.ts): the purchase was approved as
   * fuel/pharmacy/groceries under the user's cap. rawVerdict is what the
   * engine would have said without the lane. */
  bypass?: {
    category: "fuel" | "pharmacy" | "groceries" | "manual";
    merchant: string;
    cap: number;
    rawVerdict: Verdict;
    /** Manual bypasses only: points this override cost, escalating
     * within the month (1st +1, 2nd +2, …). Essential lanes never shame. */
    shameAwarded?: number;
  };
  /** True when this NO is at least the second NO for the same ask in the
   * window — the UI may offer the shame-priced manual bypass. */
  bypassAvailable?: boolean;
  /** Manual bypasses only: the deterministic goal-damage line ("your home
   * down payment moves ~2 months away"). Computed from the books; the AI
   * may phrase it, never invent it. */
  goalImpact?: string;
};

const HeadroomReportSchema = z.object({
  window: z.object({ start: z.string(), end: z.string(), label: z.string() }),
  income: z.number().finite(),
  committed: z.object({
    total: z.number().finite(),
    entries: z.array(
      z.object({
        // Fields added after the first stored decisions stay optional so
        // the existing audit trail always remains loadable.
        id: z.string().optional(),
        label: z.string(),
        monthly: z.number().finite(),
        amount: z.number().finite().optional(),
        cadence: z.enum(["monthly", "weekly", "annual"]).optional(),
        nextDue: z.string().optional(),
        endDate: z.string().nullable().optional(),
        confirmedAt: z.string().optional(),
        source: z.enum(["discovered", "user"]),
      }),
    ),
  }),
  variableSpent: z.number().finite(),
  headroom: z.number().finite(),
  ledgerRows: z.array(LedgerRowSchema).default([]),
});

/** Runtime shape of a Decision — the decisions store validates against this
 * before anything is written, so a malformed verdict can never be persisted. */
export const DecisionSchema = z.object({
  at: z.string().min(1),
  label: z.string(),
  amount: MoneySchema,
  verdict: z.enum(["YES", "NO"]),
  headroomAtTime: z.number().finite(),
  shortBy: z.number().finite().nullable(),
  reasons: z.array(z.string()),
  pathToYes: z.string().nullable(),
  planned: z.array(PlannedItemSchema).default([]),
  inputs: HeadroomReportSchema,
  engineVersion: z.string().min(1),
  adjustment: z
    .object({
      components: z.array(z.object({ label: z.string(), amount: z.number().finite() })),
      total: z.number().finite(),
      adjustedHeadroom: z.number().finite(),
      rawVerdict: z.enum(["YES", "NO"]),
      profile: ProfileSchema,
      state: z.object({ code: z.string(), name: z.string(), colIndex: z.number().finite() }),
    })
    .optional(),
  bypass: z
    .object({
      category: z.enum(["fuel", "pharmacy", "groceries", "manual"]),
      merchant: z.string(),
      cap: z.number().finite(),
      rawVerdict: z.enum(["YES", "NO"]),
      shameAwarded: z.number().int().min(0).optional(),
    })
    .optional(),
  bypassAvailable: z.boolean().optional(),
  goalImpact: z.string().optional(),
});

function fmt(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * decide() — the oracle. Pure: a function of the ask, the books, and the
 * planned items, nothing else. Same inputs + same ENGINE_VERSION = same
 * verdict, forever. The ONLY writer of verdicts — the AI narration layer is
 * physically incapable of reaching this function's inputs or outputs.
 *
 * Inputs are validated at runtime (fail LOUD, never guess): TypeScript
 * types do not exist at the MCP/PayPal boundary, so an unvalidated ask or
 * book that reaches this function is a wrong YES waiting to happen.
 */
export function decide(
  ask: Ask,
  books: Books,
  planned: PlannedItem[] = [],
): Decision {
  const parsedAsk = AskSchema.safeParse(ask);
  if (!parsedAsk.success) throw new Error(`invalid ask: ${issues(parsedAsk.error)}`);
  const parsedBooks = BooksSchema.safeParse(books);
  if (!parsedBooks.success) throw new Error(`invalid books: ${issues(parsedBooks.error)}`);
  const parsedPlanned: PlannedItem[] = [];
  for (const item of planned) {
    const p = PlannedItemSchema.safeParse(item);
    if (!p.success) throw new Error(`invalid planned item: ${issues(p.error)}`);
    parsedPlanned.push(p.data);
  }

  const validAsk = parsedAsk.data;
  const report = headroomReport(parsedBooks.data, validAsk.at);
  const h = report.headroom;
  const snapshot = parsedPlanned.map((p) => ({ ...p }));

  if (validAsk.amount <= h) {
    const remaining = round2(h - validAsk.amount);
    return {
      at: validAsk.at,
      label: validAsk.label,
      amount: validAsk.amount,
      verdict: "YES",
      headroomAtTime: h,
      shortBy: null,
      reasons: [
        `fits: ask $${fmt(validAsk.amount)} ≤ headroom $${fmt(h)}`,
        `remaining after: $${fmt(remaining)}`,
      ],
      pathToYes: null,
      planned: snapshot,
      inputs: report,
      engineVersion: ENGINE_VERSION,
    };
  }

  const shortBy = round2(validAsk.amount - h);
  const windowStart = parseInstant(report.window.start);
  const windowEnd = parseInstant(report.window.end);
  const skip = snapshot
    .filter((p) => {
      const when = parseInstant(p.when, "date");
      return p.amount >= shortBy && when >= windowStart && when < windowEnd;
    })
    .sort((a, b) => a.amount - b.amount)[0];

  const committedNames = report.committed.entries.map((e) => e.label);
  return {
    at: validAsk.at,
    label: validAsk.label,
    amount: validAsk.amount,
    verdict: "NO",
    headroomAtTime: h,
    shortBy,
    reasons: [
      `headroom $${fmt(h)} · ask $${fmt(validAsk.amount)}`,
      `short by $${fmt(shortBy)}`,
      committedNames.length > 0
        ? `committed already booked: ${committedNames.join(", ")}`
        : "committed already booked: none",
    ],
    pathToYes: skip ? `Skip ${skip.label} → YES` : null,
    planned: snapshot,
    inputs: report,
    engineVersion: ENGINE_VERSION,
  };
}
