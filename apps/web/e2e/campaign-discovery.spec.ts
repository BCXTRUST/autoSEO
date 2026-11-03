import { expect, test } from "@playwright/test";
import { captureScreenshot, rpc, signup } from "./helpers";

type Snapshot = {
  campaign: {
    config: { dailySpendLimitMicros: number; dailyPublicationLimit: number };
  };
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
    lastError: string | null;
  }>;
};

test("reviews observed community candidates before focused research", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `campaign-discovery-${stamp}@autoseo.test`, "password12", "Discovery User");
  await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
  await page.getByRole("button", { name: "New campaign" }).click();
  await page.getByLabel("Campaign name").fill("Community discovery review");
  await page.getByLabel("Website URL").fill("https://discovery.example.test/");
  await page.getByLabel("Objective").fill("Find factual, relevant community discussions.");
  await expect(page.locator(".campaign-mode-choice input[type=radio]").first()).toBeChecked();
  await page.getByRole("button", { name: "Create campaign", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/campaigns\//);

  const campaignId = new URL(page.url()).pathname.split("/").at(-1) as string;
  const beforeStart = await rpc<Snapshot>(page, "campaigns/get", { campaignId, afterSequence: 0 });
  expect(beforeStart.items).toHaveLength(0);
  expect(beforeStart.campaign.config.dailySpendLimitMicros).toBe(0);
  expect(beforeStart.campaign.config.dailyPublicationLimit).toBe(0);

  await page.getByRole("button", { name: "Start campaign" }).click();
  await page.getByRole("button", { name: "Opportunities", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Community discovery", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".discovery-search-copy strong")
      .filter({ hasText: "discovery.example.test" })
      .first(),
  ).toBeVisible({
    timeout: 60_000,
  });

  const blocked = page.locator(
    '.discovery-candidate-card:has(> a[href="https://community.discovery.example.test/private/router-board"])',
  );
  const observed = page.locator(
    '.discovery-candidate-card:has(> a[href="https://community.discovery.example.test/t/mesh-router-setup"])',
  );
  await expect(blocked.getByText("Inspection unavailable", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(blocked.getByText("robots_disallowed", { exact: true })).toBeVisible();
  await expect(blocked.getByRole("button", { name: "Use for research" })).toBeDisabled();
  await expect(blocked.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  await expect(observed.getByText("Observed · needs your review", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    observed.getByText("Fixture evidence: owners describe setting up the Acme mesh router.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    observed.getByText("Site rules observed · not reviewed", { exact: true }),
  ).toBeVisible();
  const observedSnapshot = await rpc<Snapshot>(page, "campaigns/get", {
    campaignId,
    afterSequence: 0,
  });
  const observedItem = observedSnapshot.items.find(
    (item) => item.url === "https://community.discovery.example.test/t/mesh-router-setup",
  );
  const observedDiscovery = observedItem?.details.discovery as
    | { sourceItemIds?: string[]; query?: string }
    | undefined;
  expect(observedDiscovery?.query).toBeTruthy();
  expect(observedDiscovery?.sourceItemIds?.length).toBeGreaterThan(0);
  for (const sourceItemId of observedDiscovery?.sourceItemIds ?? []) {
    const sourceItem = observedSnapshot.items.find((item) => item.id === sourceItemId);
    expect(sourceItem?.details.catalog).toBeTruthy();
  }
  await expect(
    observed.getByText(`Query: ${observedDiscovery?.query}`, { exact: true }),
  ).toBeVisible();
  await expect(observed.getByRole("link", { name: "Community rules" })).toBeVisible();

  await blocked.getByRole("button", { name: "Retry inspection" }).click();
  await expect(blocked.getByText("Observed · needs your review", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    blocked.getByText("Fixture evidence: router owners discuss mesh setup and device pairing.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(blocked.getByRole("button", { name: "Use for research" })).toBeEnabled();
  await expect(blocked.getByRole("link", { name: "Community guidelines" })).toBeVisible();

  await blocked.getByRole("button", { name: "Use for research" }).click();
  await expect(blocked.getByText("Selected for research", { exact: true })).toBeVisible();
  await expect(
    blocked.getByText("Research task: Complete. This is not approval to contribute or publish.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^Review/ }).click();
  const draft = page.locator(".campaign-draft-card").filter({
    has: page.getByRole("heading", { name: "Draft suggestion: Private Router Board", exact: true }),
  });
  await expect(draft).toBeVisible({ timeout: 45_000 });
  await expect(draft.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(
    draft.getByText("Fixture evidence: router owners discuss mesh setup and device pairing.", {
      exact: false,
    }),
  ).toBeVisible();
  await draft.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    draft.getByText("Official sources available for review", { exact: true }),
  ).toBeVisible();
  await expect(
    draft.getByText("These references were available but not sent to an AI model.", {
      exact: true,
    }),
  ).toBeVisible();
  await draft.getByText(/^Official references \(/).click();
  const officialHome = draft.locator(
    '.draft-official-references article:has(> a[href="https://discovery.example.test/"])',
  );
  await expect(officialHome.getByRole("link", { name: /Acme Mesh Router Product/ })).toBeVisible();
  await expect(
    officialHome.getByText("Acme mesh router with secure Wi-Fi setup for home.", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Opportunities", exact: true }).click();
  await observed.getByRole("button", { name: "Dismiss" }).click();
  await expect(observed.getByText("Dismissed", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "discovery-candidates-reviewed");

  await expect
    .poll(async () => {
      const snapshot = await rpc<Snapshot>(page, "campaigns/get", {
        campaignId,
        afterSequence: 0,
      });
      return snapshot.jobs.filter(
        (job) =>
          ["discovery_search", "discovery_inspect", "research_opportunity"].includes(
            job.operation,
          ) &&
          ["queued", "running", "deferred", "reconciling", "waiting_external"].includes(job.status),
      ).length;
    })
    .toBe(0);

  const snapshot = await rpc<Snapshot>(page, "campaigns/get", { campaignId, afterSequence: 0 });
  const selected = snapshot.items.find(
    (item) => item.url === "https://community.discovery.example.test/private/router-board",
  );
  const dismissed = snapshot.items.find(
    (item) => item.url === "https://community.discovery.example.test/t/mesh-router-setup",
  );
  expect((selected?.details.discovery as Record<string, unknown>)?.disposition).toBe("selected");
  expect((dismissed?.details.discovery as Record<string, unknown>)?.disposition).toBe("dismissed");
  expect(
    snapshot.items.some((item) => item.kind === "draft" && item.status === "needs_action"),
  ).toBe(true);
  expect(snapshot.items.some((item) => item.kind === "publication")).toBe(false);
  expect(snapshot.jobs.some((job) => job.operation === "ai_draft")).toBe(false);
  const challengeStatus = await rpc<{ tasks: unknown[] }>(page, "campaigns/challengeStatus", {
    campaignId,
  });
  expect(challengeStatus.tasks).toHaveLength(0);
  const publicationActions = await rpc<unknown[]>(page, "campaigns/publicationActions", {
    campaignId,
  });
  expect(publicationActions).toHaveLength(0);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Community discovery review", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Opportunities", exact: true }).click();
  const persistedBlocked = page.locator(
    '.discovery-candidate-card:has(> a[href="https://community.discovery.example.test/private/router-board"])',
  );
  const persistedDismissed = page.locator(
    '.discovery-candidate-card:has(> a[href="https://community.discovery.example.test/t/mesh-router-setup"])',
  );
  await expect(persistedBlocked.getByText("Selected for research", { exact: true })).toBeVisible();
  await expect(persistedDismissed.getByText("Dismissed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Review/ }).click();
  await expect(
    page.getByRole("heading", { name: "Draft suggestion: Private Router Board", exact: true }),
  ).toBeVisible();
});
