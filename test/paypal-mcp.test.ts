import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePayPalOrder, createPayPalOrder } from "../src/paypal";
import { createApp } from "../src/server";

function stubFetch(responses: Response[]): typeof fetch {
  let i = 0;
  const fn = async () => responses[i++] ?? new Response("{}", { status: 500 });
  return Object.assign(fn, { preconnect: () => {} });
}

afterEach(() => {
  delete process.env.CANI_PAYPAL_CLIENT_ID;
  delete process.env.CANI_PAYPAL_CLIENT_SECRET;
});

describe("PayPal Orders rails (mocked transport)", () => {
  test("create order parses id + approve link; capture returns status", async () => {
    process.env.CANI_PAYPAL_CLIENT_ID = "id";
    process.env.CANI_PAYPAL_CLIENT_SECRET = "secret";
    const order = await createPayPalOrder({ amount: 42.5, label: "watch" }, stubFetch([
      new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
      new Response(JSON.stringify({
        id: "ORDER-1", status: "CREATED",
        links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" }],
      }), { status: 201 }),
    ]));
    expect(order.id).toBe("ORDER-1");
    expect(order.approveUrl).toContain("sandbox.paypal.com");
    const captured = await capturePayPalOrder("ORDER-1", stubFetch([
      new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
      new Response(JSON.stringify({ id: "ORDER-1", status: "COMPLETED" }), { status: 200 }),
    ]));
    expect(captured.status).toBe("COMPLETED");
  });
});

describe("MCP surface — the same engine, for agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "cani-mcp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  type RpcBody = {
    result: {
      serverInfo: { name: string };
      tools: { name: string }[];
      structuredContent: {
        decision: { verdict: string };
        paypal: { outcome: string; order: unknown };
      };
      isError?: boolean;
    };
  };
  const rpc = async (method: string, params?: Record<string, unknown>, id = 1) => {
    const res = await app.fetch(new Request("http://cani.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }));
    return { status: res.status, body: (await res.json()) as RpcBody };
  };

  test("initialize, manifest, and tools/list describe cani.ask + checkout.attempt", async () => {
    const init = await rpc("initialize");
    expect(init.body.result.serverInfo.name).toBe("cani");
    const manifest = await app.fetch(new Request("http://cani.test/mcp/manifest"));
    const tools = ((await manifest.json()) as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(["cani.ask", "checkout.attempt"]);
    const list = await rpc("tools/list");
    expect(list.body.result.tools.length).toBe(2);
  });

  test("cani.ask answers NO; checkout.attempt declines without creating an order", async () => {
    const ask = await rpc("tools/call", { name: "cani.ask", arguments: { amount: 2800, label: "Aeron Deck" } });
    expect(ask.body.result.structuredContent.decision.verdict).toBe("NO");
    const attempt = await rpc("tools/call", { name: "checkout.attempt", arguments: { amount: 2800, label: "Aeron Deck" } });
    expect(attempt.body.result.structuredContent.decision.verdict).toBe("NO");
    expect(attempt.body.result.structuredContent.paypal.outcome).toBe("declined");
    expect(attempt.body.result.structuredContent.paypal.order).toBe(null);
    expect(attempt.body.result.isError).toBe(true);
  });
});
