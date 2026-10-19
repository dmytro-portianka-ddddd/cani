import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DecisionSchema, type Decision } from "./decide";

/**
 * The decisions store — the audit trail. Append-only JSONL, one verdict per
 * line, same discipline as the ledger: malformed rows fail LOUD with the
 * line number, a verdict is validated before it is written, and nothing is
 * ever edited in place. Any NO (or YES) can be re-derived from its stored
 * inputs snapshot + engineVersion.
 */
export function loadDecisions(path: string): Decision[] {
  if (!existsSync(path)) return [];
  const decisions: Decision[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `decisions ${path} line ${i + 1}: not valid JSON (${(err as Error).message})`,
      );
    }
    const parsed = DecisionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `decisions ${path} line ${i + 1}: malformed decision (${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(", ")})`,
      );
    }
    decisions.push(parsed.data as Decision);
  }
  return decisions;
}

/** Append a verdict. Never rewrites, never deletes — the file only grows. */
export function appendDecision(path: string, decision: Decision): Decision {
  const parsed = DecisionSchema.safeParse(decision);
  if (!parsed.success) {
    throw new Error(
      `refusing to append malformed decision (${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")})`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(parsed.data)}\n`, "utf8");
  return parsed.data as Decision;
}
