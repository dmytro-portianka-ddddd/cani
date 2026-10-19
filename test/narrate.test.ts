import { afterEach, describe, expect, test } from "bun:test";
import { decide } from "../src/decide";
import { narrateVerdict } from "../src/narrate";
import type { Books } from "../src/schema";

const books: Books = {
  committed: [],
  ledger: [{ id: "s", at: "2026-06-01T09:00:00.000Z", type: "deposit", amount: 1000, label: "paycheck" }],
};
const noDecision = decide({ amount: 2800, label: "Aeron Deck", at: "2026-06-15T19:04:00.000Z" }, books);

function fakeFetch(content: string): typeof fetch {
  const fn = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return Object.assign(fn, { preconnect: () => {} });
}

afterEach(() => {
  delete process.env.CANI_AI_API_KEY;
});

describe("verdict narration — bars with AI, plain YES/NO without", () => {
  test("no AI key: the fallback is just the verdict", async () => {
    delete process.env.CANI_AI_API_KEY;
    const n = await narrateVerdict(noDecision);
    expect(n.mode).toBe("plain");
    expect(n.lines).toEqual(["NO"]);
  });

  test("validated bars are shown, verdict word intact", async () => {
    process.env.CANI_AI_API_KEY = "test-key";
    const n = await narrateVerdict(
      noDecision,
      fakeFetch("Read the books, did the math, let me make it plain though\nNO — that $2,800 deck ain't sailin' today, no\nShort by $1,800 and the month's already spoken for\n— your manager, guardin' the door"),
    );
    expect(n.mode).toBe("bars");
    expect(n.lines.join(" ")).toContain("NO");
  });

  test("bars that flip the verdict are rejected to plain", async () => {
    process.env.CANI_AI_API_KEY = "test-key";
    const n = await narrateVerdict(noDecision, fakeFetch("YES go get it\nYES spend it all\nYES yes yes"));
    expect(n.mode).toBe("plain");
    expect(n.lines).toEqual(["NO"]);
  });

  test("bars that invent money are rejected to plain", async () => {
    process.env.CANI_AI_API_KEY = "test-key";
    const n = await narrateVerdict(
      noDecision,
      fakeFetch("NO on the deck, that's the call I made\nOnly $9,999 short, what a shame\nNO means no"),
    );
    expect(n.mode).toBe("plain");
  });
});
