import { describe, expect, test } from "bun:test";
import { decide } from "../src/decide";
import { headroomReport } from "../src/headroom";
import { ENGINE_VERSION } from "../src/version";
import type { Books, CommittedPayment, LedgerRow, PlannedItem } from "../src/schema";

/** The spec's flagship example (SPEC.md, headroom model): income $8,900 ·
 * committed $2,400 (Mortgage 1200 + Daycare 423 + Honda 777) · variable spent
 * $4,600 → headroom $1,900. Attempt: wife's deck $2,800 → over by $900 →
 * hard NO. (Income corrected from the spec's $7,000 — 7000 − 2400 − 4600
 * is $0, not the $1,900 the anchors require; the deck/short-by arithmetic
 * pins income at $8,900.) */
const AT = "2026-06-15T19:04:00.000Z"; // window = 2026-06
const WINDOW_SALARY_AT = "2026-06-01T09:00:00.000Z";

function cp(overrides: Partial<CommittedPayment>): CommittedPayment {
  return {
    id: "x",
    label: "X",
    amount: 100,
    cadence: "monthly",
    nextDue: "2026-07-01",
    endDate: null,
    source: "user",
    confirmedAt: "2026-06-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return { id: "r", at: AT, type: "variable_spend", amount: 1, ...overrides };
}

const books: Books = {
  committed: [
    cp({ id: "mortgage", label: "Mortgage", amount: 1200 }),
    cp({ id: "daycare", label: "Daycare", amount: 423 }),
    cp({ id: "honda", label: "Honda", amount: 777 }),
  ],
  ledger: [
    row({
      id: "salary",
      type: "deposit",
      amount: 8900,
      at: WINDOW_SALARY_AT,
      label: "paycheck",
    }),
    row({ id: "v1", amount: 3800, label: "renovation" }),
    row({ id: "v2", amount: 800, label: "groceries" }),
  ],
};

describe("decide — the spec's flagship example", () => {
  test("the wife's $2,800 deck → NO, over by $900, with reasons in bars", () => {
    const d = decide({ amount: 2800, label: "Aeron Deck", at: AT }, books);
    expect(d.verdict).toBe("NO");
    expect(d.headroomAtTime).toBe(1900);
    expect(d.shortBy).toBe(900);
    expect(d.reasons[0]).toBe("headroom $1900 · ask $2800");
    expect(d.reasons[1]).toBe("short by $900");
    expect(d.reasons[2]).toBe("committed already booked: Mortgage, Daycare, Honda");
    expect(d.engineVersion).toBe(ENGINE_VERSION);
    expect(d.inputs.window.label).toBe("2026-06");
    expect(d.inputs.committed.total).toBe(2400);
    expect(d.inputs.variableSpent).toBe(4600);
  });

  test("a $1,500 ask → YES with what remains after", () => {
    const d = decide({ amount: 1500, label: "watch", at: AT }, books);
    expect(d.verdict).toBe("YES");
    expect(d.headroomAtTime).toBe(1900);
    expect(d.shortBy).toBe(null);
    expect(d.reasons[1]).toBe("remaining after: $400");
    expect(d.pathToYes).toBe(null);
  });

  test("deterministic: same inputs, same decision, forever", () => {
    const a = decide({ amount: 2800, label: "Aeron Deck", at: AT }, books);
    const b = decide({ amount: 2800, label: "Aeron Deck", at: AT }, books);
    expect(a).toEqual(b);
    expect(a.engineVersion).toBe(b.engineVersion);
  });
});

describe("decide — the arithmetic that earns the authority", () => {
  test("annual bills annualize in: $1,200/yr insurance adds $100/mo committed", () => {
    const withInsurance: Books = {
      committed: [
        ...books.committed,
        cp({ id: "insurance", label: "Insurance", amount: 1200, cadence: "annual" }),
      ],
      ledger: books.ledger,
    };
    const d = decide({ amount: 2800, label: "Aeron Deck", at: AT }, withInsurance);
    expect(d.inputs.committed.total).toBe(2500);
    expect(d.headroomAtTime).toBe(1800);
  });

  test("loan end-dates auto-release: Honda paid off before the window → headroom widens on its own", () => {
    const hondaReleased: Books = {
      committed: books.committed.map((p) =>
        p.id === "honda" ? { ...p, endDate: "2026-05-31" } : p,
      ),
      ledger: books.ledger,
    };
    const d = decide({ amount: 2800, label: "Aeron Deck", at: AT }, hondaReleased);
    expect(d.inputs.committed.total).toBe(1623); // 2400 − 777
    expect(d.headroomAtTime).toBe(2677); // 8900 − 1623 − 4600
  });

  test("a declined checkout moved no money — it never decrements headroom", () => {
    const withDeclined: Books = {
      committed: books.committed,
      ledger: [
        ...books.ledger,
        row({
          id: "attempt",
          type: "checkout",
          amount: 500,
          envelope: "deck",
          orderId: "PAY-ORDER-1",
          result: "declined",
        }),
      ],
    };
    const d = decide({ amount: 2800, label: "Aeron Deck", at: AT }, withDeclined);
    expect(d.headroomAtTime).toBe(1900);
  });

  test("an executed checkout is spend: headroom decrements", () => {
    const withExecuted: Books = {
      committed: books.committed,
      ledger: [
        ...books.ledger,
        row({
          id: "attempt",
          type: "checkout",
          amount: 500,
          envelope: "deck",
          orderId: "PAY-ORDER-2",
          result: "executed",
        }),
      ],
    };
    const d = decide({ amount: 2800, label: "Aeron Deck", at: AT }, withExecuted);
    expect(d.headroomAtTime).toBe(1400);
  });
});

describe("decide — the path back to YES", () => {
  test("the smallest planned item that covers the shortfall opens the door", () => {
    const planned: PlannedItem[] = [
      { label: "March trip", amount: 1200, when: "2026-06-22" },
      { label: "new grill", amount: 500, when: "2026-06-20" },
      { label: "March trip (big)", amount: 2000, when: "2026-06-25" },
    ];
    const d = decide({ amount: 2800, label: "Aeron Deck", at: AT }, books, planned);
    expect(d.pathToYes).toBe("Skip March trip → YES");
  });

  test("a planned item outside this window opens no door", () => {
    const d = decide({ amount: 2800, label: "Aeron Deck", at: AT }, books, [
      { label: "old trip", amount: 5000, when: "2020-01-01" },
      { label: "next month trip", amount: 5000, when: "2026-07-10" },
    ]);
    expect(d.pathToYes).toBe(null);
  });

  test("nothing planned covers the shortfall → the NO stands without a door", () => {
    const d = decide(
      { amount: 2800, label: "Aeron Deck", at: AT },
      books,
      [{ label: "new grill", amount: 500, when: "2026-06-20" }],
    );
    expect(d.pathToYes).toBe(null);
  });
});

describe("decide — hardened boundaries (regressions from code review)", () => {
  test("a negative or fractional-cent ask fails loud, never a silent YES", () => {
    expect(() => decide({ amount: -500, label: "x", at: AT }, books)).toThrow(/invalid ask/);
    expect(() => decide({ amount: 10.005, label: "x", at: AT }, books)).toThrow(/invalid ask/);
    expect(() => decide({ amount: Number.POSITIVE_INFINITY, label: "x", at: AT }, books)).toThrow(/invalid ask/);
  });

  test("an invalid ask date fails loud instead of crashing the window math", () => {
    expect(() => decide({ amount: 10, label: "x", at: "not-a-date" }, books)).toThrow(/invalid ask/);
  });

  test("a duplicate ledger row id is refused — replays cannot inflate headroom", () => {
    const dup: Books = {
      committed: books.committed,
      ledger: [...books.ledger, { ...books.ledger[0]! }],
    };
    expect(() => decide({ amount: 10, label: "x", at: AT }, dup)).toThrow(/duplicate ledger row id/);
  });

  test("window membership follows the instant, not the timestamp text", () => {
    const offset: Books = {
      committed: [],
      ledger: [
        row({ id: "a", type: "deposit", amount: 1000, at: "2026-06-01T00:30:00+02:00" }), // May 31 UTC
        row({ id: "b", type: "deposit", amount: 1000, at: "2026-05-31T23:30:00-02:00" }), // Jun 1 UTC
      ],
    };
    expect(headroomReport(offset, AT).income).toBe(1000);
  });

  test("an end-date on the window's first day keeps the payment booked that month", () => {
    const ending: Books = {
      committed: [cp({ id: "h", label: "H", amount: 777, endDate: "2026-06-01" })],
      ledger: books.ledger,
    };
    expect(headroomReport(ending, AT).committed.total).toBe(777);
  });

  test("an unconfirmed payment has no teeth", () => {
    const unconfirmed: Books = {
      committed: [cp({ id: "u", label: "U", amount: 777, confirmedAt: "not-a-date" })],
      ledger: books.ledger,
    };
    expect(headroomReport(unconfirmed, AT).committed.total).toBe(0);
  });

  test("a monthly payment that has not begun yet is not committed; an annual one accrues", () => {
    const future: Books = {
      committed: [
        cp({ id: "f", label: "Future", amount: 500, nextDue: "2026-09-01" }),
        cp({ id: "ins", label: "Insurance", amount: 1200, cadence: "annual", nextDue: "2027-01-01" }),
      ],
      ledger: books.ledger,
    };
    expect(headroomReport(future, AT).committed.total).toBe(100);
  });

  test("weekly cadence converts (× 52 ÷ 12) and the snapshot carries the counted rows", () => {
    const weekly: Books = {
      committed: [cp({ id: "w", label: "Gym", amount: 70, cadence: "weekly" })],
      ledger: books.ledger,
    };
    const d = decide({ amount: 100, label: "x", at: AT }, weekly);
    expect(d.inputs.committed.total).toBe(303.33);
    expect(d.inputs.committed.entries[0]?.id).toBe("w");
    expect(d.inputs.ledgerRows.map((r) => r.id)).toContain("salary");
  });
});
