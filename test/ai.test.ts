import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesDraft } from "../src/ai";
import { BLOT_CARDS, scoreBlot } from "../src/blot";
import { createApp } from "../src/server";

describe("AI profile drafting (propose-only)", () => {
  test("the offline reader extracts a grounded draft from free text", () => {
    const r = rulesDraft("I'm 56, house is paid off here in Mississippi, no kids at home. I want to enjoy life a bit more this year — honestly I'm a spender.");
    expect(r.source).toBe("rules");
    expect(r.draft.ageBand).toBe("50s");
    expect(r.draft.housing).toBe("paid-off");
    expect(r.draft.dependents).toBe("none");
    expect(r.draft.state).toBe("MS");
    expect(r.draft.temperament).toBe("live-a-little");
    expect(r.draft.goal).toBe("enjoy-now");
  });

  test("family text reads as family", () => {
    const r = rulesDraft("We're in our thirties, renting in Texas with two kids in daycare, saving for a first home.");
    expect(r.draft.ageBand).toBe("30s-40s");
    expect(r.draft.housing).toBe("renting");
    expect(r.draft.dependents).toBe("kids-daycare");
    expect(r.draft.state).toBe("TX");
    expect(r.draft.goal).toBe("buy-home");
  });
});

describe("the money blot", () => {
  test("five cards; careful answers suggest a careful profile", () => {
    expect(BLOT_CARDS.length).toBe(5);
    const answers = BLOT_CARDS.map((c) => ({ cardId: c.id, choiceId: "a" }));
    const result = scoreBlot(answers);
    expect(result.answered).toBe(5);
    expect(result.suggestion.temperament).toBe("careful");
    expect(result.reasons.length).toBe(5);
  });

  test("bogus answers are ignored, not fatal", () => {
    expect(scoreBlot([{ cardId: "nope", choiceId: "x" }]).answered).toBe(0);
  });
});

describe("draft + blot APIs never save anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "cani-ai-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const req = (path: string, init?: RequestInit) => app.fetch(new Request(`http://cani.test${path}`, init));
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("draft returns a profile sketch and the saved profile stays empty", async () => {
    const res = await req("/api/profile/draft", post({ text: "I'm 56, house paid off in Mississippi, I'm a spender who wants to enjoy this year." }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: { ageBand?: string }; source: string };
    expect(body.draft.ageBand).toBe("50s");
    const profile = (await (await req("/api/profile")).json()) as { profile: unknown };
    expect(profile.profile).toBe(null);
  });

  test("blot cards load and score over the API", async () => {
    const cards = (await (await req("/api/blot")).json()) as { cards: unknown[] };
    expect(cards.cards.length).toBe(5);
    const scored = (await (await req("/api/blot", post({ answers: [{ cardId: "windfall", choiceId: "c" }] }))).json()) as { suggestion: { temperament?: string } };
    expect(scored.suggestion.temperament).toBe("live-a-little");
    expect((await req("/api/profile/draft", post({ text: "" }))).status).toBe(400);
  });
});
