/**
 * Rehearse the MCP surface the way a real agent client would:
 * initialize → notifications/initialized → tools/list → cani.ask →
 * checkout.attempt, over real HTTP against a fresh seeded server.
 * With PayPal credentials configured, the YES attempt creates a real
 * sandbox order (never captured — harmless).
 *
 * Run: bun run rehearse-mcp
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";

const app = createApp(mkdtempSync(join(tmpdir(), "cani-rehearsal-")));
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
const url = `http://127.0.0.1:${server.port}/mcp`;
let seq = 0;

async function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  });
  if (res.status === 202) return { accepted: true };
  return (await res.json()) as Record<string, unknown>;
}

function show(label: string, value: unknown): void {
  console.log(`\n— ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rehearsal", version: "1.0" } });
show("initialize", (init.result as Record<string, unknown>)?.serverInfo ?? init);
await rpc("notifications/initialized");
const list = await rpc("tools/list");
show("tools/list", ((list.result as Record<string, unknown>)?.tools as { name: string }[]).map((t) => t.name));

const ask = await rpc("tools/call", { name: "cani.ask", arguments: { amount: 2800, label: "Aeron Deck" } });
const askResult = (ask.result as Record<string, unknown>)?.structuredContent as { decision: { verdict: string; shortBy: number } };
show("cani.ask $2,800 deck", `${askResult.decision.verdict} (short by $${askResult.decision.shortBy})`);

const attemptNo = await rpc("tools/call", { name: "checkout.attempt", arguments: { amount: 2800, label: "Aeron Deck" } });
const noResult = (attemptNo.result as Record<string, unknown>)?.structuredContent as { paypal: { outcome: string; order: unknown } };
show("checkout.attempt deck (agent tries anyway)", `${noResult.paypal.outcome} — order: ${JSON.stringify(noResult.paypal.order)}`);

const attemptYes = await rpc("tools/call", { name: "checkout.attempt", arguments: { amount: 25, label: "USB cable" } });
const yesResult = (attemptYes.result as Record<string, unknown>)?.structuredContent as { paypal: { outcome: string; order: { id: string } | null; note: string } };
show("checkout.attempt $25 cable", `${yesResult.paypal.outcome} — order: ${yesResult.paypal.order?.id ?? "none"} (${yesResult.paypal.note})`);

server.stop(true);
console.log("\nRehearsal complete: the agent was refused, then served — by the same engine as the app.");
