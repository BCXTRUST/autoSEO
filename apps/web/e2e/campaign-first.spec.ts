import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("new accounts land in campaigns and controlled review state persists", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `campaign-first-${stamp}@rakazo.test`, "password12", "Campaign User");
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
  await expect(
    page.getByText("Research mode starts at zero spend", { exact: false }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "campaign-dashboard-new-account");

  const newCampaignButton = page.getByRole("button", { name: "New campaign" });
  await newCampaignButton.click();
  const createDialog = page.getByRole("dialog", { name: "Create campaign" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(createDialog.getByRole("button", { name: "Create campaign" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toHaveCount(0);
  await expect(newCampaignButton).toBeFocused();
  await newCampaignButton.click();
  await page.getByLabel("Campaign name").fill("Fixture launch research");
  await page.getByLabel("Website URL").fill("https://example.com");
  await page.getByLabel("Objective").fill("Exercise the controlled review workflow.");
  await page.locator(".campaign-mode-choice input[type=radio]").nth(1).check();
  await page.getByRole("button", { name: "Create campaign", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/campaigns\//);
  await expect(page.getByText("fixture outcomes are test-only", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Opportunities" }).click();
  await page.getByRole("button", { name: "Add URL" }).click();
  await page.getByLabel("Public page URL").fill("https://example.com/research");
  await page.getByLabel("Label").fill("Example research page");
  await page.getByRole("button", { name: "Add to research" }).click();
  await expect(page.getByText("Example research page", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Start campaign" }).click();
  await expect(page.locator(".campaign-status.active").first()).toBeVisible();
  await expect(
    page.getByText("Controlled test opportunity timed out once", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /Review/ }).click();
  const draft = page.locator(".campaign-draft-card").filter({
    has: page.getByRole("heading", { name: "Controlled test draft" }),
  });
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Accounts" }).click();
  await expect(page.getByRole("heading", { name: "Controlled test account" })).toBeVisible();
  await expect(page.getByText("Test-only fixture", { exact: true })).toBeVisible();
  await expect(page.getByText("Email fixture: confirmed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Overview" }).click();
  const controlledResearchJob = page
    .locator(".campaign-job-row")
    .filter({ hasText: "controlled_fixture" });
  await expect(controlledResearchJob.locator(".job-status-waiting_review")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".campaign-topbar .campaign-status.paused")).toBeVisible();
  await page.getByRole("button", { name: /Review/ }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(draft.getByText("Approved", { exact: true })).toBeVisible();
  await draft.getByRole("button", { name: "Edit draft" }).click();
  await draft
    .getByRole("textbox", { name: "Edit Controlled test draft" })
    .fill("Edited after approval; approval must be reset.");
  await draft.getByRole("button", { name: "Save changes" }).click();
  await expect(draft.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(
    draft.getByText("Edited after approval; approval must be reset.", {
      exact: true,
    }),
  ).toBeVisible();
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(draft.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator(".campaign-topbar .campaign-status.active")).toBeVisible();

  await page.getByRole("button", { name: "Results" }).click();
  await expect(page.getByRole("heading", { name: "Controlled test publication" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    page.getByText("Independently verified by the controlled fixture.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 45_000 });

  await page.getByRole("button", { name: "Overview" }).click();
  await expect(controlledResearchJob.locator(".job-status-succeeded")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator(
      ".campaign-job-row .job-status-queued, .campaign-job-row .job-status-deferred, .campaign-job-row .job-status-running",
    ),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Review items needing action" })).toHaveCount(0);
  await page.getByRole("button", { name: "Results" }).click();

  const feedCount = await page.locator(".campaign-event").count();
  let abortNextSnapshot = true;
  await page.route("**/rpc/campaigns/get", async (route) => {
    if (abortNextSnapshot) {
      abortNextSnapshot = false;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Refresh campaign" }).click();
  await expect(
    page.getByText("Connection interrupted · showing the last saved snapshot", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Controlled test publication" })).toBeVisible();
  await page.unroute("**/rpc/campaigns/get");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByText("Connection interrupted · showing the last saved snapshot", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator(".campaign-event")).toHaveCount(feedCount);
  await expect(
    page.getByText("Independently verified by the controlled fixture.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Pause all", exact: true }).first().click();
  const pauseDialog = page.getByRole("alertdialog", {
    name: "Pause all active campaigns?",
  });
  await expect(pauseDialog).toBeVisible();
  await pauseDialog.getByRole("button", { name: "Pause all", exact: true }).click();
  await expect(page.locator(".campaign-topbar .campaign-status.paused")).toBeVisible();
  await page.getByRole("button", { name: "Results" }).click();
  await expect(page.getByRole("heading", { name: "Controlled test publication" })).toBeVisible();
  await expect(
    page.getByText("Independently verified by the controlled fixture.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Fixture launch research" })).toBeVisible();
  await expect(page.locator(".campaign-topbar .campaign-status.paused")).toBeVisible();
  await page.getByRole("button", { name: /Review/ }).click();
  await expect(
    page.getByText("Edited after approval; approval must be reset.", {
      exact: true,
    }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "campaign-review-after-reload");
});
