import { describe, expect, it } from "vitest";
import {
  addMarket,
  addWizardPage,
  artifactImageSrc,
  canStart,
  emptyDraft,
  emptyPage,
  PAGE_BOX_LIMIT,
  parseAllowedSite,
  patchFromDraft,
  RESPONSIBILITY_SENTENCE,
  removeWizardPage,
  WIZARD_STEPS,
  warmupNote,
  withPagePrefill,
  withPersonaPrefill,
  wizardStepIssues,
} from "./model.js";

describe("link builder wizard", () => {
  it("lists five setup steps and keeps policy defaults off the rail", () => {
    expect([...WIZARD_STEPS]).toEqual([
      "Brand",
      "Who writes",
      "How many links",
      "Which pages",
      "Start",
    ]);
  });

  it("renders only raster image artifacts as data URLs", () => {
    expect(artifactImageSrc({ mimeType: "image/png", contentBase64: "iVBO" })).toBe(
      "data:image/png;base64,iVBO",
    );
    expect(artifactImageSrc({ mimeType: "text/html", contentBase64: "PGh0bWw+" })).toBeNull();
    expect(artifactImageSrc({ mimeType: "image/svg+xml", contentBase64: "PHN2Zz4=" })).toBeNull();
  });

  it("starts on DE and derives US locale and time zone", () => {
    const draft = emptyDraft();
    expect(draft.markets[0]).toMatchObject({
      country: "DE",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    });
    expect(draft.disclosureMode).toBe("undisclosed_persona");
    const withUs = addMarket(draft, "us");
    expect(withUs.markets[1]).toMatchObject({
      country: "US",
      locale: "en-US",
      timezoneId: "America/New_York",
    });
  });

  it("describes warm-up in days without changing the wait", () => {
    expect(warmupNote(24)).toBe(
      "The first live link waits about 1 day. Until then the account posts without a link.",
    );
    expect(warmupNote(48)).toContain("2 days");
  });

  it("requires brand fields, a topic, and a saved inbox before start", () => {
    const draft = emptyDraft();
    expect(wizardStepIssues(0, draft).length).toBeGreaterThan(0);
    draft.name = "Nordlicht";
    draft.brandName = "Nordlicht";
    draft.allowedDomains = "nordlicht.example";
    expect(wizardStepIssues(0, draft)).toEqual([]);
    draft.displayName = "Mira";
    expect(wizardStepIssues(1, draft)).toEqual([]);
    expect(wizardStepIssues(2, draft)).toEqual([]);
    draft.pages = [
      { id: "page-schlaf", url: "https://nordlicht.example/schlaf", keyword: "Schlaf", rules: "" },
    ];
    expect(wizardStepIssues(3, draft)).toEqual([]);
    expect(canStart(draft)).toBe(false);
    draft.mailboxId = "mbx-1";
    expect(canStart(draft)).toBe(true);
  });

  it("accepts a site with www, https, and a path", () => {
    expect(parseAllowedSite("https://www.vitaminexpress.org/de")).toEqual({
      ok: true,
      domain: "vitaminexpress.org",
      targetUrl: "https://www.vitaminexpress.org/de",
    });
    expect(parseAllowedSite("www.vitaminexpress.org").ok).toBe(true);
    expect(parseAllowedSite("vitaminexpress.org")).toMatchObject({
      ok: true,
      domain: "vitaminexpress.org",
      targetUrl: null,
    });
    expect(parseAllowedSite("http://vitaminexpress.org/de/")).toMatchObject({
      ok: true,
      targetUrl: "http://vitaminexpress.org/de",
    });
    expect(parseAllowedSite("not a site").ok).toBe(false);

    const draft = emptyDraft();
    draft.name = "Vitaminexpress";
    draft.brandName = "Vitaminexpress";
    draft.allowedDomains = "https://www.vitaminexpress.org/de";
    expect(wizardStepIssues(0, draft)).toEqual([]);
    const patch = patchFromDraft(draft);
    expect(patch.allowedDomains).toEqual(["vitaminexpress.org"]);
    expect(patch.targets.map((target) => target.url)).toEqual([
      "https://www.vitaminexpress.org/de",
    ]);
    draft.pages = [
      {
        id: "page-mag",
        url: "https://www.vitaminexpress.org/de/magnesium-kaufen",
        keyword: "Magnesium kaufen",
        rules: "Use the page's own wording.",
      },
    ];
    const saved = patchFromDraft(draft);
    expect(saved.targets[0]).toMatchObject({
      url: "https://www.vitaminexpress.org/de/magnesium-kaufen",
      description: "Use the page's own wording.",
      keywordClusters: ["Magnesium kaufen"],
    });
    expect(saved.topicLanes[0]).toMatchObject({ tag: "Magnesium kaufen" });
    expect(saved.facts).toEqual(["Use the page's own wording."]);
  });

  it("prefills the first page from the brand site and stops at 10 boxes", () => {
    const draft = emptyDraft();
    draft.allowedDomains = "https://www.vitaminexpress.org/de";
    const filled = withPagePrefill(draft);
    expect(filled.pages[0]?.url).toBe("https://www.vitaminexpress.org/de");
    expect(filled.pages[0]?.keyword).toBe("");
    filled.pages[0] = {
      ...filled.pages[0]!,
      url: "https://vitaminexpress.org/other",
      keyword: "Other",
    };
    expect(withPagePrefill(filled).pages[0]?.url).toBe("https://vitaminexpress.org/other");
    let many = filled;
    for (let index = 0; index < 12; index += 1) many = addWizardPage(many);
    expect(many.pages).toHaveLength(PAGE_BOX_LIMIT);
    expect(removeWizardPage(many, 1).pages).toHaveLength(PAGE_BOX_LIMIT - 1);
    expect(removeWizardPage({ ...draft, pages: [emptyPage()] }, 0).pages).toHaveLength(1);
  });

  it("prefills an empty bio from the brand and path", () => {
    const draft = emptyDraft();
    draft.brandName = "Vitaminexpress";
    draft.allowedDomains = "https://www.vitaminexpress.org/de";
    const filled = withPersonaPrefill(draft);
    expect(filled.displayName).not.toMatch(/vitamin/i);
    expect(filled.displayName).toMatch(/\s/);
    expect(filled.bio).toContain("Vitaminexpress");
    expect(filled.bio).toContain("/de");
    draft.bio = "Already written";
    expect(withPersonaPrefill(draft).bio).toBe("Already written");
  });

  it("keeps acceptance as a sentence with no checkbox field", () => {
    expect(RESPONSIBILITY_SENTENCE).toMatch(/responsible/i);
    expect(RESPONSIBILITY_SENTENCE.toLowerCase()).not.toContain("checkbox");
  });
});
