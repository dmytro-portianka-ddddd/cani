/**
 * Records the Cani demo as a real browser video (Playwright recordVideo).
 * The flow is the demo script: build a profile, run a few transactions,
 * hit the hard NO, pay a shame point to bypass it, then watch medicine
 * ride the pharmacy lane. Run: bun run demo:video
 * Output: demo-video/cani-demo.webm
 */
import { chromium } from "@playwright/test";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";

const app = createApp(mkdtempSync(join(tmpdir(), "cani-demo-")));
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
const base = `http://127.0.0.1:${server.port}`;
console.log(`recording against ${base}`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 900 },
  recordVideo: { dir: "demo-video", size: { width: 420, height: 900 } },
});
const page = await context.newPage();
const tid = (id: string) => page.getByTestId(id);
const pause = (ms = 1100) => page.waitForTimeout(ms);

async function caption(text: string): Promise<void> {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText = "position:fixed;left:10px;right:10px;bottom:12px;z-index:99;background:#111;color:#ffd21f;font:700 15px Arial;padding:12px 14px;border:3px solid #ffd21f;box-shadow:5px 5px 0 #111";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await pause(3600);
}

await page.goto(base);
await caption("This is Cani — you don't check it on Sunday. You ask it before money moves.");
await caption("One number runs everything: income, minus what is already committed, minus what you already spent. That is headroom.");
await pause(600);

// --- Upload: a typical month discovers the books -------------------------
await tid("tab-upload").click();
await caption("Level 2: show Cani a typical month — a plain bank CSV.");
await caption("It reads the month and proposes your books: income, everyday spend, and the payments that look committed.");
await tid("sample-month").click();
await pause(1400);
await caption("Mortgage and daycare, spotted on their own. Inference discovers…");
await caption("…the human confirms, and only then does code decide. A silently missed payment would mean a wrong YES — and a wrong YES kills this product.");
await pause(800);

// --- Profile: who I am, who I want to be --------------------------------
await tid("tab-profile").click();
await caption("Level 1: feel it. Who I am, and who I want to be — the character on screen is me, on paper.");
await caption("Thirty-something. A mortgage. Kids in daycare. Two incomes. Watch him assemble as I answer.");
await tid("chip-ageBand-30s-40s").click(); await pause(500);
await tid("chip-housing-mortgage").click(); await pause(500);
await tid("chip-dependents-kids-daycare").click(); await pause(500);
await tid("chip-familyStatus-married-dual-income").click(); await pause(500);
await tid("profile-state").selectOption("TX"); await pause(400);
await tid("chip-goal-buy-home").click(); await pause(500);
await tid("chip-horizon-3-5-years").click(); await pause(500);
await tid("chip-temperament-balanced").click(); await pause(400);
await tid("dial-enjoy").fill("62"); await pause(600);
await caption("The goal: a house of our own, in the next few years. The dials say how I honestly lean — security, saving, family first.");
await caption("These answers can shade a verdict later — but only as named line items, never as a hidden nudge.");
await tid("save-profile").click();
await pause(1000);
await caption("Profile saved. It can shade a verdict — every adjustment named. The books still rule.");
await tid("essentials-pharmacy-cap").fill("1500");
await tid("save-essentials").click();
await pause(800);
await caption("And the essential lanes: medicine rides free, up to a cap I set.");
await tid("blot-start").click();
await caption("The money blot: five cards, no wrong answers. It suggests — I decide.");
for (let i = 0; i < 5; i++) { await tid("blot-choice").first().click(); await pause(450); }
await pause(1000);

// --- A few ordinary transactions -----------------------------------------
await tid("tab-cani").click();
await caption("Back on the Cani tab, a normal week happens first — three ordinary transactions.");
await caption("Every spend lands in an append-only ledger and headroom moves live. Nothing is ever edited; corrections are new rows.");
for (const [label, amount] of [["Groceries", "140"], ["School supplies", "65"], ["Date night fund", "80"]] as const) {
  await tid("spend-label").fill(label);
  await tid("spend-amount").fill(amount);
  await tid("add-spend").click();
  await pause(800);
}
await caption("Three transactions in. This is the money that is actually still mine to decide about.");

// A small YES, recorded.
await tid("ask-label").fill("Concert tickets");
await tid("ask-amount").fill("150");
await tid("ask-submit").click();
await pause(1200);
await caption("A small ask first: concert tickets, $150. Clean YES.");
await caption("Recording it is a real checkout — watch headroom drop by exactly $150. A YES is spend, not applause.");
await tid("record-purchase").click();
await pause(1000);

// --- The NO ----------------------------------------------------------------
await tid("ask-label").fill("Aeron Deck");
await tid("ask-amount").fill("2800");
await tid("ask-submit").click();
await pause(1500);
await caption("Now the moment this app exists for. The deck: $2,800, at the register, before any money moves.");
await caption("NO. Short by a named amount, reasons in bars — committed costs already spoken for. And look: there is no button to argue with.");
await tid("ask-submit").click();
await pause(1500);
await caption("Ask the same thing twice, though, and the manager steps aside — for a price.");
await caption("The bypass is yours, not the math's. It costs shame points, priced in goal damage: months your down payment just moved away.");
await tid("shame-bypass").click();
await pause(1800);
await caption("Bypassed. Shame +1 — and the original NO stays in the audit trail forever. Do this systematically, and Cani will tell you to realign the goal instead of fining you forever.");

// --- The grocery cart check --------------------------------------------------
await tid("ask-label").fill("Weekly groceries");
await tid("ask-merchant").fill("Kroger");
await tid("ask-amount").fill("120");
await tid("ask-items").fill("Milk 50\nEggs 40\nBeer 30");
await tid("ask-submit").click();
await pause(1600);
await caption("Weekly groceries at Kroger — normally an essential lane, no interrogation.");
await caption("But the cart is checked item by item, by a model when one is configured: milk and eggs ride free… the beer does not. The lane denies the whole ask and names the beer.");

// --- The pharmacy lane -------------------------------------------------------
await tid("ask-label").fill("Insulin");
await tid("ask-merchant").fill("CVS Pharmacy");
await tid("ask-items").fill("");
await tid("ask-amount").fill("1300");
await tid("ask-submit").click();
await pause(1800);
await caption("And medicine never begs: $1,300 of insulin at CVS, priced over my adjusted headroom…");
await caption("…rides the pharmacy lane straight through. Books alone said NO; deeper mode said NO; essentials said this is life. No shame in this lane, ever.");
await pause(1200);
await page.getByTestId("decision-list").scrollIntoViewIfNeeded();
await caption("Every verdict lands here: the NOs, the bypass, the lane — each with its inputs and engine version, reproducible forever.");
await caption("That audit trail is why a NO can be trusted: it is arithmetic with a paper trail, not an opinion.");
await pause(1000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await caption("A budget app would have shown you a chart about last month.");
await caption("This isn't a budget. It's a manager.");

const video = page.video();
await context.close();
await browser.close();
server.stop(true);
if (video) {
  const path = await video.path();
  renameSync(path, join("demo-video", "cani-demo.webm"));
  console.log("video saved: demo-video/cani-demo.webm");
}
