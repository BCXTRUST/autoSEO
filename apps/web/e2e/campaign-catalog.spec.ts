import { expect, test } from "@playwright/test";
import { captureScreenshot, rpc, signup } from "./helpers";

type CampaignSnapshot = {
  items: Array<{
    id: string;
    kind: string;
    status: string;
    title: string;
    url: string | null;
    body: string;
    details: Record<string, unknown>;
  }>;
  jobs: Array<{
    id: string;
    itemId: string | null;
    operation: string;
    status: string;
    attemptCount: number;
    maxAttempts: number;
    lastError: string | null;
  }>;
  activities: Array<{ sequence: number; summary: string }>;
};

test("research catalogs an official site without manual URLs and retries a blocked page", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `catalog-research-${stamp}@autoseo.test`, "password12", "Catalog User");
  await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
  await page.getByRole("button", { name: "New campaign" }).click();
  await page.getByLabel("Campaign name").fill("Official site catalog");
  await page.getByLabel("Website URL").fill("https://catalog.example.test/");
  await page.getByLabel("Objective").fill("Review factual public pages for campaign context.");
  await expect(page.locator(".campaign-mode-choice input[type=radio]").first()).toBeChecked();
  await page.getByRole("button", { name: "Create campaign", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/campaigns\//);
  await expect(page.getByRole("heading", { name: "Official site catalog" })).toBeVisible();

  const campaignId = new URL(page.url()).pathname.split("/").at(-1) as string;
  const beforeStart = await rpc<CampaignSnapshot>(page, "campaigns/get", {
    campaignId,
    afterSequence: 0,
  });
  expect(beforeStart.items).toHaveLength(0);

  await page.getByRole("button", { name: "Start campaign" }).click();
  await expect(page.locator(".campaign-topbar .campaign-status.active")).toBeVisible();
  await page.getByRole("button", { name: /^Catalog/ }).click();
  await expect(page.getByText("Configured site", { exact: false })).toContainText(
    "https://catalog.example.test/",
  );

  const blockedPage = page.locator(
    '.campaign-catalog-page:has(> a[href="https://catalog.example.test/app/blocked"])',
  );
  await expect(blockedPage).toBeVisible({ timeout: 45_000 });
  await expect(blockedPage.getByText("Error", { exact: true })).toBeVisible();
  await expect(blockedPage.getByText("page_forbidden", { exact: false })).toBeVisible();
  await blockedPage.getByRole("button", { name: /Retry catalog page/ }).click();
  await expect(
    blockedPage.getByText("Catalog fixture recovered after an explicit human retry.", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(blockedPage.getByText("Fetched", { exact: true })).toBeVisible();
  const homepage = page.locator(
    '.campaign-catalog-page:has(> a[href="https://catalog.example.test/"])',
  );
  await expect(homepage.getByRole("heading", { name: "Catalog Fixture Home" })).toBeVisible();
  await expect(
    homepage.getByText("Observed link candidates · not fetched", { exact: false }),
  ).toBeVisible();
  await expect(
    homepage.getByText("Catalog fixture homepage for a mesh router service.", { exact: false }),
  ).toBeVisible();
  await expect(homepage.getByText("Mesh router product", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const snapshot = await rpc<CampaignSnapshot>(page, "campaigns/get", {
        campaignId,
        afterSequence: 0,
      });
      return snapshot.jobs.filter((job) =>
        ["queued", "running", "deferred", "reconciling", "waiting_external"].includes(job.status),
      ).length;
    })
    .toBe(0);

  const snapshot = await rpc<CampaignSnapshot>(page, "campaigns/get", {
    campaignId,
    afterSequence: 0,
  });
  const recovered = snapshot.items.find(
    (item) => item.url === "https://catalog.example.test/app/blocked",
  );
  expect(recovered).toMatchObject({ status: "verified" });
  expect(
    snapshot.jobs.find((job) => job.operation === "catalog_page" && job.itemId === recovered?.id),
  ).toMatchObject({ status: "succeeded", attemptCount: 1 });
  expect(
    snapshot.items.filter(
      (item) =>
        item.details.catalog !== null &&
        typeof item.details.catalog === "object" &&
        !Array.isArray(item.details.catalog),
    ).length,
  ).toBeLessThanOrEqual(12);
  expect(recovered?.body).toContain("Catalog fixture recovered after an explicit human retry.");
  expect(snapshot.items.some((item) => item.kind === "draft")).toBe(false);
  expect(snapshot.jobs.some((job) => job.operation === "ai_draft")).toBe(false);
  const challengeStatus = await rpc<{ tasks: unknown[] }>(page, "campaigns/challengeStatus", {
    campaignId,
  });
  expect(challengeStatus.tasks).toHaveLength(0);

  await page.getByRole("button", { name: /^Catalog/ }).click();
  await captureScreenshot(page, testInfo, "official-site-catalog-after-retry");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByText("No task running", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review items needing action" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review", exact: true }).locator(".campaign-tab-count"),
  ).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Official site catalog" })).toBeVisible();
  await page.getByRole("button", { name: /^Catalog/ }).click();
  const persistedBlockedPage = page.locator(
    '.campaign-catalog-page:has(> a[href="https://catalog.example.test/app/blocked"])',
  );
  await expect(persistedBlockedPage.getByText("Fetched", { exact: true })).toBeVisible();
  await expect(
    persistedBlockedPage.getByText("Catalog fixture recovered after an explicit human retry.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review", exact: true }).locator(".campaign-tab-count"),
  ).toHaveCount(0);
});
