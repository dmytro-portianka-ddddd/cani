import { expect, test } from "@playwright/test";

/**
 * Core user flows, end to end through a real browser against the real
 * server + engine. Locators are data-testid only (see playwright.config
 * testIdAttribute) so specs survive visual redesigns. Serial: the flows
 * share one seeded ledger on purpose — each step spends the headroom the
 * previous step left behind, exactly like a user would.
 * Seeded books: headroom starts at $1,900.
 */
test.describe.serial("Cani core flows", () => {
  test("the shell loads: headroom, books, installable PWA", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Cani/);
    await expect(page.getByTestId("headroom-amount")).toHaveText("$1,900.00");
    await expect(page.getByTestId("committed-value")).toHaveText("$2,400.00");
    await expect(page.getByTestId("committed-list")).toContainText("Mortgage");
    await expect(page.getByTestId("committed-list")).toContainText("Honda");

    // Installability, checked the way a browser checks it.
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
    const manifest = await page.request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    const body = (await manifest.json()) as { display: string; icons: { sizes: string }[] };
    expect(body.display).toBe("standalone");
    expect(body.icons.map((i) => i.sizes)).toContain("512x512");
    // Tabs: Profile and Upload start hidden behind their tabs.
    await expect(page.getByTestId("character-scene")).toBeHidden();
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("character-scene")).toBeVisible();
    await expect(page.getByTestId("headroom-amount")).toBeHidden();
    await page.getByTestId("tab-cani").click();
    await expect(page.getByTestId("headroom-amount")).toBeVisible();
    const swActive = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.active !== null;
    });
    expect(swActive).toBe(true);
  });

  test("the flagship NO: $2,800 deck, short by $900, no way through", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("ask-label").fill("Aeron Deck");
    await page.getByTestId("ask-amount").fill("2800");
    await page.getByTestId("ask-submit").click();

    await expect(page.getByTestId("verdict-word")).toHaveText("NO");
    // No AI key in the test server: the fallback is the plain verdict, no bars.
    await expect(page.getByTestId("verdict-bars")).toBeHidden();
    await expect(page.getByTestId("verdict-sub")).toContainText("Short by $900.00");
    await expect(page.getByTestId("verdict-reasons")).toContainText("committed already booked: Mortgage, Daycare, Honda");
    // Teeth: there is literally no purchase button on a NO.
    await expect(page.getByTestId("record-purchase")).toBeHidden();
    await expect(page.getByTestId("no-override")).toBeVisible();
    // And the verdict is on the record.
    await expect(page.getByTestId("decision-list")).toContainText("Aeron Deck");
    await expect(page.getByTestId("kept-amount")).toContainText("$2,800.00");
  });


  test("second NO unlocks the shame bypass — and the score shows it", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("ask-label").fill("Aeron Deck");
    await page.getByTestId("ask-amount").fill("2800");
    await page.getByTestId("ask-submit").click();
    await expect(page.getByTestId("verdict-word")).toHaveText("NO");
    const shame = page.getByTestId("shame-bypass");
    await expect(shame).toBeVisible();
    await shame.click();
    await expect(page.getByTestId("verdict-word")).toHaveText("YES");
    await expect(page.getByTestId("verdict-sub")).toContainText("Shame +1");
    await expect(page.getByTestId("shame-score")).toContainText("Shame points this month: 1");
  });


  test("essential lane: medicine rides free over headroom, within the cap", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("essentials-pharmacy-cap").fill("3000");
    await page.getByTestId("save-essentials").click();
    await page.getByTestId("tab-cani").click();
    await page.getByTestId("ask-label").fill("insulin");
    await page.getByTestId("ask-merchant").fill("CVS Pharmacy");
    await page.getByTestId("ask-amount").fill("2500");
    await page.getByTestId("ask-submit").click();
    await expect(page.getByTestId("verdict-word")).toHaveText("YES");
    await expect(page.getByTestId("verdict-sub")).toContainText("Essential lane (pharmacy)");
    await expect(page.getByTestId("verdict-reasons")).toContainText("essential lane: pharmacy at CVS Pharmacy");
  });

  test("a YES can be recorded — and recording it spends the headroom", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("ask-label").fill("watch");
    await page.getByTestId("ask-amount").fill("1500");
    await page.getByTestId("ask-submit").click();

    await expect(page.getByTestId("verdict-word")).toHaveText("YES");
    // The PayPal door only exists on a YES.
    await expect(page.getByTestId("paypal-pay")).toBeVisible();
    await page.getByTestId("paypal-pay").click();
    await expect(page.getByTestId("paypal-area")).toBeVisible();
    await expect(page.getByTestId("paypal-note2")).not.toHaveText("");
    const record = page.getByTestId("record-purchase");
    await expect(record).toBeVisible();
    await record.click();
    // $1,900 − $1,500 recorded checkout = $400 left.
    await expect(page.getByTestId("headroom-amount")).toHaveText("$400.00");
  });

  test("adding spend decrements headroom live", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("headroom-amount")).toHaveText("$400.00");
    await page.getByTestId("spend-label").fill("groceries");
    await page.getByTestId("spend-amount").fill("100");
    await page.getByTestId("add-spend").click();
    await expect(page.getByTestId("headroom-amount")).toHaveText("$300.00");
  });

  test("deeper mode: the who-am-I tree can shade a marginal verdict — in the open", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-profile").click();
    // Unfilled fields blink until answered, then stop.
    await expect(page.getByTestId("group-ageBand")).toHaveClass(/unfilled/);
    await page.getByTestId("chip-ageBand-50s").click();
    await expect(page.getByTestId("group-ageBand")).not.toHaveClass(/unfilled/);
    await expect(page.getByTestId("group-housing")).toHaveClass(/unfilled/);
    await page.getByTestId("chip-housing-paid-off").click();
    await page.getByTestId("chip-dependents-none").click();
    await page.getByTestId("chip-familyStatus-married-dual-income").click();
    await page.getByTestId("dial-enjoy").fill("80");
    await expect(page.getByTestId("character-caption")).toContainText("two incomes");
    await expect(page.getByTestId("character-scene")).toContainText("PAID!");
    await page.getByTestId("profile-state").selectOption("MS");
    await page.getByTestId("chip-goal-enjoy-now").click();
    await page.getByTestId("chip-horizon-this-year").click();
    await page.getByTestId("chip-temperament-live-a-little").click();

    const save = page.getByTestId("save-profile");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId("insight-archetype")).toHaveText("Established and mortgage-free");
    await expect(page.getByTestId("insight")).toContainText("Suggested buffer");

    // Headroom is $300 on the books. $800 is a raw NO — deeper mode
    // (+$600 capped adjustment) says YES, and shows its work.
    await page.getByTestId("tab-cani").click();
    await page.getByTestId("ask-label").fill("deck chairs");
    await page.getByTestId("ask-amount").fill("800");
    await page.getByTestId("ask-submit").click();
    await expect(page.getByTestId("verdict-word")).toHaveText("YES");
    await expect(page.getByTestId("verdict-sub")).toContainText("Books alone said NO");
    await expect(page.getByTestId("books-verdict")).toContainText("Books: NO");
    await expect(page.getByTestId("manager-verdict")).toContainText("Manager: YES");
    await expect(page.getByTestId("verdict-reasons")).toContainText("deeper mode: books headroom");
  });

  test("Level 1: free text drafts the tree — and saves nothing by itself", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("free-text").fill("I'm 56, house is paid off here in Mississippi, no kids at home. I want to enjoy life a bit more this year — honestly I'm a spender.");
    await page.getByTestId("draft-profile").click();
    await expect(page.getByTestId("draft-note")).toBeVisible();
    await expect(page.getByTestId("draft-note")).toContainText("Review every field");
    await expect(page.getByTestId("chip-ageBand-50s")).toHaveClass(/selected/);
    await expect(page.getByTestId("chip-housing-paid-off")).toHaveClass(/selected/);
  });

  test("Level 1: the money blot suggests, the human applies", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("blot-start").click();
    for (let i = 0; i < 5; i++) {
      await page.getByTestId("blot-choice").first().click();
    }
    await expect(page.getByTestId("blot-result")).toBeVisible();
    await expect(page.getByTestId("blot-reasons")).toContainText("Suggested:");
    await page.getByTestId("blot-apply").click();
    await expect(page.getByTestId("chip-temperament-careful")).toHaveClass(/selected/);
  });

  test("Level 2: a sample month proposes books, confirming lands them", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-upload").click();
    // Connection state depends on the runner's env (.env may exist) —
    // assert the status renders, not which side of it we're on.
    await expect(page.getByTestId("level-paypal")).toContainText(/connected|credentials/);
    await page.getByTestId("sample-month").click();
    await expect(page.getByTestId("proposal-summary")).toContainText("committed candidate");
    await expect(page.getByTestId("candidate-list")).toContainText("Sample Mortgage");
    await page.getByTestId("apply-month").click();
    await expect(page.getByTestId("apply-result")).toContainText("Sample Mortgage");
    await expect(page.getByTestId("level-month")).toContainText("done");
    await page.getByTestId("tab-cani").click();
    await expect(page.getByTestId("committed-list")).toContainText("Sample Mortgage");
  });
});
