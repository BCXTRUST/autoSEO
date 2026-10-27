import type { LbHostView, LbThreadView } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResearchBoard } from "./research-board";

const host: LbHostView = {
  id: "host",
  registrableDomain: "board.example.org",
  homepageUrl: "https://board.example.org/",
  platform: "phpbb",
  country: "US",
  language: "en",
  locale: "en-US",
  timezoneId: "America/New_York",
  status: "qualified",
  parkedFrom: null,
  qualityScore: 0.8,
  topicTags: ["meditation"],
  captchaType: null,
  hrefForNewMembers: "unknown",
  relDefault: "unknown",
  signatureLinks: false,
  minPostsForLinks: null,
  registerUrl: null,
  statusReason: null,
  lastProbeAt: new Date().toISOString(),
};
const thread: LbThreadView = {
  id: "page",
  hostId: "host",
  domain: host.registrableDomain,
  url: "https://board.example.org/thread/1",
  title: "How do you build a meditation habit?",
  excerpt: "Looking for practical ways to get started",
  status: "selected",
  relevance: 0.9,
  openQuestion: true,
  laneId: null,
  rejectReason: null,
};

describe("research missions", () => {
  it("counts eligible sites separately from rejected candidates", () => {
    const html = renderToStaticMarkup(
      <ResearchBoard
        hosts={[host, { ...host, id: "rejected", status: "off_topic" }]}
        threads={[]}
        searches={1}
        currentUrl={null}
        dailyLimit={20}
        targetCount={5}
      />,
    );
    expect(html).toContain("1/5 eligible sites");
    expect(html).toContain("Finding replacements for skipped sites");
    expect(html).not.toContain("Research limit reached");
    expect(html).not.toContain("daily cap");
    expect(html).toContain("goal 5 eligible sites");
  });
  it("does not count yesterday's eligible sites toward today's goal", () => {
    const html = renderToStaticMarkup(
      <ResearchBoard
        hosts={[{ ...host, lastProbeAt: new Date(Date.now() - 86400000).toISOString() }]}
        threads={[]}
        searches={0}
        currentUrl={null}
        targetCount={5}
      />,
    );
    expect(html).toContain("0/5 eligible sites");
  });
  it("shows real targets, recorded evidence, decisions, and safe visit links", () => {
    const html = renderToStaticMarkup(
      <ResearchBoard
        hosts={[host]}
        threads={[thread]}
        searches={3}
        currentUrl={null}
        dailyLimit={20}
      />,
    );
    expect(html).toContain("3 searches recorded today");
    expect(html).toContain(thread.title);
    expect(html).toContain("Picked");
    expect(html).toContain("daily cap 20 sites");
    expect(html).toContain(`href="${thread.url}"`);
    expect(html).toContain(thread.excerpt);
  });
  it("keeps rejected-site pages skipped and never renders unsafe visit URLs", () => {
    const html = renderToStaticMarkup(
      <ResearchBoard
        hosts={[{ ...host, status: "off_topic" }]}
        threads={[{ ...thread, url: "javascript:alert(1)" }]}
        searches={0}
        currentUrl={null}
      />,
    );
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("Skipped 2");
    expect(html).toContain("No eligible sites in this batch.");
    expect(html).toContain("Nothing is being registered or posted.");
    expect(html).toContain("Picked 0");
  });
  it("does not invent progress when there are no saved results", () => {
    const html = renderToStaticMarkup(
      <ResearchBoard hosts={[]} threads={[]} searches={0} currentUrl={null} />,
    );
    expect(html).toContain("No research results recorded yet");
    expect(html).toContain("No pages saved yet");
    expect(html).not.toContain("Research is running");
  });
});
