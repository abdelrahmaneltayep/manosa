import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

/**
 * The buyer's quote page, driven for real.
 *
 * Like the registration form, this is our own page on our own domain, so it can
 * actually be exercised in a browser — and it is exercised with JavaScript off,
 * because a buyer committing to a price must not depend on a script loading.
 *
 * Accepting needs an Admin API session that does not exist here, so these cover
 * everything up to that point: what the buyer reads, that a stale link is
 * refused, and that declining works without JS. The accept path itself is
 * covered against a fake admin in `tests/integration/quotes.test.ts`.
 */

test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.TEST_DATABASE_URL ??
        "postgresql://mannon:mannon@localhost:5432/mannon_test?schema=public",
    },
  },
});

const SHOP = "e2e-quotes.myshopify.com";
const LIVE = "e2e-live-quote-token-000000000000";
const EXPIRED = "e2e-expired-quote-token-00000000";

const day = 86_400_000;

async function seedQuote(publicId: string, overrides: Record<string, unknown> = {}) {
  const quote = await db.quote.create({
    data: {
      shop: SHOP,
      publicId,
      number: "Q-1001",
      email: "buyer@acme.test",
      company: "Acme Ltd",
      status: "SENT",
      currencyCode: "USD",
      subtotal: 65000,
      message: "Happy to do these at the tier price.",
      sentAt: new Date(Date.now() - day),
      expiresAt: new Date(Date.now() + 9 * day),
      lockedAt: new Date(Date.now() - day),
      ...overrides,
    },
  });

  await db.quoteLine.create({
    data: {
      shop: SHOP,
      quoteId: quote.id,
      variantId: "gid://shopify/ProductVariant/1",
      title: "Blue Mug — Large",
      sku: "MUG-BL-L",
      quantity: 100,
      unitPrice: 650,
      listPrice: 1000,
      appliedRuleIds: [],
      ruleSummary: "Wholesale 35%",
    },
  });

  return quote;
}

test.beforeAll(async () => {
  await db.quoteLine.deleteMany({ where: { shop: SHOP } });
  await db.quote.deleteMany({ where: { shop: SHOP } });
  await db.shop.deleteMany({ where: { shop: SHOP } });

  await db.shop.create({
    data: {
      shop: SHOP,
      name: "Alpha Wholesale",
      planKey: "growth",
      billingStatus: "ACTIVE",
    },
  });

  await seedQuote(LIVE);
  await seedQuote(EXPIRED, {
    number: "Q-1002",
    expiresAt: new Date(Date.now() - day),
    sentAt: new Date(Date.now() - 20 * day),
  });
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a buyer can read their quote and its prices", async ({ page }) => {
    await page.goto(`/q/${LIVE}`);

    await expect(page.getByRole("heading", { name: /Q-1001/ })).toBeVisible();
    await expect(page.getByText("Blue Mug — Large")).toBeVisible();
    // The locked unit price and the total, as they were quoted.
    await expect(page.getByText("$6.50")).toBeVisible();
    await expect(page.getByText("Total: $650.00")).toBeVisible();
    await expect(page.getByText("Happy to do these at the tier price.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept this quote" })).toBeVisible();
  });

  test("no horizontal scroll on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/q/${LIVE}`);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });

  test("an expired quote offers no buttons, and says what to do", async ({ page }) => {
    await page.goto(`/q/${EXPIRED}`);

    await expect(page.getByText(/has run out/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept this quote" })).toHaveCount(0);
  });

  test("arriving at an expired quote marks it expired for the merchant too", async ({
    page,
  }) => {
    await page.goto(`/q/${EXPIRED}`);
    const quote = await db.quote.findUniqueOrThrow({ where: { publicId: EXPIRED } });
    // What the buyer reads and what the merchant sees have to agree.
    expect(quote.status).toBe("EXPIRED");
  });

  test("a token that was never issued is not told apart from a missing quote", async ({
    page,
  }) => {
    const response = await page.goto("/q/definitely-not-a-real-token");
    expect(response?.status()).toBe(404);
  });

  test("declining works with the form alone", async ({ page }) => {
    const token = "e2e-decline-quote-token-000000000";
    await seedQuote(token, { number: "Q-1003" });

    await page.goto(`/q/${token}`);
    await page.getByRole("button", { name: "No thanks" }).click();

    await expect(page.getByText(/Thank you for letting us know/)).toBeVisible();
    const quote = await db.quote.findUniqueOrThrow({ where: { publicId: token } });
    expect(quote.status).toBe("DECLINED");
  });
});
