import { z } from "zod";
import type { Decision } from "./decide";
import { resolveAiConfig } from "./ai";

/**
 * The voice of the manager — narration duty only.
 *
 * When an AI provider is configured, it turns a finished verdict into a
 * few original rapid-fire rap bars (late-90s battle-rap energy, written
 * fresh — never quoted, never presented as anyone's actual work). The
 * bars are validated before they may be shown:
 * - they must state the verdict the engine computed, word for word;
 * - they may not invent numbers (any $ figure must come from the decision);
 * - short, capped, plain text.
 * Any failure — no key, provider down, rhyme disagrees with the math —
 * falls back to the plain verdict: just YES, or just NO. The rhyme can
 * never soften, flip, or re-argue the arithmetic; decide() already spoke.
 */

export type Narration = {
  mode: "bars" | "plain";
  lines: string[];
  note: string;
};

const MAX_LINES = 6;

function plain(decision: Decision, note: string): Narration {
  return { mode: "plain", lines: [decision.verdict], note };
}

function allowedNumbers(decision: Decision): Set<string> {
  const nums = new Set<string>();
  const add = (n: number | null) => {
    if (n === null) return;
    nums.add(String(n));
    nums.add(n.toFixed(2));
    nums.add(n.toLocaleString("en-US"));
    nums.add(n.toLocaleString("en-US", { minimumFractionDigits: 2 }));
  };
  add(decision.amount);
  add(decision.headroomAtTime);
  add(decision.shortBy);
  return nums;
}

export function validateBars(decision: Decision, rawLines: string[]): Narration | null {
  const lines = rawLines.map((l) => l.trim()).filter((l) => l !== "").slice(0, MAX_LINES);
  if (lines.length < 2) return null;
  const joined = lines.join(" ");
  // The bars must say what the engine said.
  const saysYes = /\bYES\b/.test(joined);
  const saysNo = /\bNO\b/.test(joined);
  if (decision.verdict === "YES" ? !saysYes || saysNo : !saysNo || saysYes) return null;
  // No invented money: every $ amount in the rhyme must be decision data.
  const allowed = allowedNumbers(decision);
  for (const match of joined.matchAll(/\$([\d,]+(?:\.\d{2})?)/g)) {
    const value = (match[1] ?? "").replace(/,/g, "");
    const normalized = String(Number(value));
    if (!allowed.has(value) && !allowed.has(normalized) && !allowed.has(Number(value).toFixed(2))) return null;
  }
  if (joined.length > 600) return null;
  return { mode: "bars", lines, note: "Bars by the AI narration layer — the verdict above is pure arithmetic." };
}

const SYSTEM_PROMPT = `You are the voice of Cani, a money manager with late-90s battle-rap energy:
rapid-fire internal rhymes, punchlines, cocky but protective — a manager guarding
their artist's money, never shaming them. Write 4 short original lines announcing
the verdict given to you. Rules: state the verdict word (YES or NO) exactly;
use ONLY the dollar figures provided, never invent numbers; no profanity;
no quoting or imitating any specific artist's lyrics; sign off as the manager.
Reply with ONLY the lines, one per line, no JSON, no preamble.`;

type FetchFn = typeof fetch;

export async function narrateVerdict(decision: Decision, fetchFn: FetchFn = fetch): Promise<Narration> {
  const config = resolveAiConfig();
  if (!config) return plain(decision, "Plain verdict — set CANI_AI_API_KEY or GEMINI_API_KEY to give the manager a voice.");
  const { apiKey, baseUrl, model } = config;
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Verdict: ${decision.verdict}. Item: ${decision.label}. Ask: $${decision.amount}. Headroom: $${decision.headroomAtTime}.${decision.shortBy !== null ? ` Short by: $${decision.shortBy}.` : ""}${decision.pathToYes ? ` Path back: ${decision.pathToYes}.` : ""} Reasons: ${decision.reasons.join("; ")}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`provider ${res.status}`);
    const payload: unknown = await res.json();
    const content = z
      .object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) })
      .parse(payload).choices[0]?.message.content;
    if (!content) throw new Error("empty completion");
    return validateBars(decision, content.split("\n")) ?? plain(decision, "The bars disagreed with the math, so: plain verdict.");
  } catch {
    return plain(decision, "The manager's voice is offline — plain verdict.");
  }
}
