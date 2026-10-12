import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdapterContext,
  type BrowserPersona,
  type BrowserSession,
  CaptchaSolverError,
  FakeBrowserSession,
  FakeCaptchaSolver,
} from "@rakazo/adapter-kit";
import { LocalBrowserSessionFactory } from "@rakazo/linkbuilder-browser";
import { browserTestGate, FIXTURE_PAGE_HELPER_DIR } from "@rakazo/linkbuilder-browser/testing";
import { HELPER_LABELS, HELPER_PLACING_TIMEOUT_MS, TEST_PACING } from "@rakazo/linkbuilder-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captchaCropAcceptable,
  detectKnowledgeQuestion,
  instructionClickSelector,
  isLoginPath,
  isSecretRegistrationPrompt,
  looksLikeKnowledgeQuestion,
  pngDimensions,
  runPageHelper,
  solveImageCaptcha,
} from "./captcha.js";
import { acceptCookieWall, consentAcceptText, COOKIE_ACCEPT_SELECTORS } from "./cookie-wall.js";
import { boardDriverFor } from "./index.js";
import { PhpbbDriver, phpbbPermalink, phpbbTopicUrl } from "./phpbb.js";
import { type FixtureMail, renderBbcode, startPhpbbFixture } from "./testing/phpbb-fixture.js";
import { noisePng, TINY_PNG } from "./testing/png.js";
import { normalizeTargetUrl, VerifyRefused, verifyPlacement } from "./verify.js";
import { detectWidget } from "./widgets.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

const driver = new PhpbbDriver();
const target = "https://www.vereinsplaner.example/mitglieder?utm_source=forum";

describe("phpBB driver helpers", () => {
  it("includes the German board cookie accept control", () => {
    expect(COOKIE_ACCEPT_SELECTORS).toContain("a[onclick*='ca_accept']");
    expect(COOKIE_ACCEPT_SELECTORS).toContain("button:has-text('Akzeptieren und weiter')");
    expect(consentAcceptText("Akzeptieren und weiter")).toBe(true);
    expect(consentAcceptText("Werbefrei für 3.99€ im Monat")).toBe(false);
  });

  it("clicks a consent control that page text does not include", async () => {
    let clicked = false;
    const session = {
      async exists() {
        return false;
      },
      async clickConsent() {
        clicked = true;
        return true;
      },
    } as unknown as BrowserSession;
    expect(await acceptCookieWall(session)).toBe("accepted");
    expect(clicked).toBe(true);
  });

  it("reads a German activation-key notice as waiting for email", async () => {
    const notice =
      "Dein Benutzerkonto wurde erstellt. Du musst es jedoch erst freischalten. Dazu wurde ein Aktivierungs-Schlüssel an die von dir angegebene Adresse geschickt.";
    const session = new FakeBrowserSession(
      "activation",
      { projectId: "p", profileKey: "k", locale: "de-DE", timezoneId: "Europe/Berlin" },
      {
        "https://board.example/registered": {
          text: notice,
          elements: { "div#message": { text: notice } },
        },
      },
    );
    await session.goto("https://board.example/registered");
    expect(await driver.readRegistrationResult(session)).toEqual({ kind: "pending_email" });
  });

  it("checks the privacy agreement on the registration form", async () => {
    const privacy = "form#register input[type='checkbox'][name='agreed']";
    const session = new FakeBrowserSession(
      "privacy",
      { projectId: "p", profileKey: "k", locale: "de-DE", timezoneId: "Europe/Berlin" },
      {
        "https://board.example/register": {
          text: "",
          elements: {
            "#username": {},
            "#email": {},
            "#new_password": {},
            "#password_confirm": {},
            [privacy]: { checked: false },
          },
        },
      },
    );
    await session.goto("https://board.example/register");
    await driver.fillRegistration(session, {
      username: "mira",
      email: "mira@inbox.example",
      password: "secret-password",
    });
    expect(
      session.actions.some((action) => action.kind === "click" && action.selector === privacy),
    ).toBe(true);
    expect(session.actions.some((action) => action.kind === "fill" && action.value === "secret-password")).toBe(
      false,
    );
    const again = new FakeBrowserSession(
      "privacy-checked",
      { projectId: "p", profileKey: "k", locale: "de-DE", timezoneId: "Europe/Berlin" },
      {
        "https://board.example/register": {
          text: "",
          elements: {
            "#username": {},
            "#email": {},
            "#new_password": {},
            "#password_confirm": {},
            [privacy]: { checked: true },
          },
        },
      },
    );
    await again.goto("https://board.example/register");
    await driver.fillRegistration(again, {
      username: "mira",
      email: "mira@inbox.example",
      password: "secret-password",
    });
    expect(again.actions.some((action) => action.kind === "click")).toBe(false);

    const yes = "form#register input[type='radio'][name='privacy'][value='1']";
    const radios = new FakeBrowserSession(
      "privacy-radio",
      { projectId: "p", profileKey: "k", locale: "de-DE", timezoneId: "Europe/Berlin" },
      {
        "https://board.example/register": {
          text: "",
          elements: {
            "#username": {},
            "#email": {},
            "#new_password": {},
            "#password_confirm": {},
            [yes]: { checked: false },
          },
        },
      },
    );
    await radios.goto("https://board.example/register");
    await driver.fillRegistration(radios, {
      username: "mira",
      email: "mira@inbox.example",
      password: "secret-password",
    });
    expect(radios.actions.some((action) => action.kind === "click" && action.selector === yes)).toBe(
      true,
    );
  });

  it("leaves a dismissed cookie bar alone", async () => {
    const session = new FakeBrowserSession(
      "cookies",
      { projectId: "p", profileKey: "k", locale: "de-DE", timezoneId: "Europe/Berlin" },
      {
        "https://board.example/": {
          text: "",
          elements: {
            "a[onclick*='ca_accept']": { text: "Ich stimme zu", hidden: true },
          },
        },
      },
    );
    await session.goto("https://board.example/");
    expect(await acceptCookieWall(session)).toBe("none");
    expect(session.actions.some((action) => action.kind === "click")).toBe(false);
  });

  it("is registered for phpBB", () => {
    expect(boardDriverFor("phpbb")).toBeInstanceOf(PhpbbDriver);
    expect(
      driver.detect(
        "<input id='confirm_code'> viewtopic.php",
        "http://b.example/viewtopic.php?t=1",
      ),
    ).toBe(true);
  });

  it("searches the board for the problem and keeps a stable topic URL", async () => {
    const topic = "ul.topics li.row:nth-of-type(1) a.topictitle";
    const replies = "ul.topics li.row:nth-of-type(1) dd.posts";
    const search =
      "https://board.example/phpbb/search.php?keywords=Magnesium%20Kr%C3%A4mpfe&sr=topics&sk=t&sd=d";
    const session = new FakeBrowserSession(
      "search",
      { projectId: "p", profileKey: "k", locale: "de-DE", timezoneId: "Europe/Berlin" },
      {
        [search]: {
          text: "",
          elements: {
            [topic]: {
              text: "Krämpfe in den Füßen",
              attributes: {
                href: "./viewtopic.php?t=148343&sid=abc&hilit=Magnesium",
              },
            },
            [replies]: { text: "4" },
          },
        },
      },
    );
    const threads = await driver.searchThreads(
      session,
      "https://board.example/phpbb/",
      "Magnesium Krämpfe",
    );
    expect(threads).toEqual([
      {
        url: "https://board.example/phpbb/viewtopic.php?t=148343",
        title: "Krämpfe in den Füßen",
        replyCount: 4,
      },
    ]);
    expect(session.actions).toContainEqual({ kind: "goto", url: search });
    expect(
      phpbbTopicUrl(
        "https://board.example/phpbb/viewtopic.php?t=9&sid=zzz",
        "https://board.example/phpbb/",
      ),
    ).toBe("https://board.example/phpbb/viewtopic.php?t=9");
    expect(await driver.searchThreads(session, "https://board.example/phpbb/", "  ")).toEqual([]);
  });

  it("confirms the reply rules before typing", async () => {
    const box = "form#postform input[type='checkbox']";
    const message = "form#postform textarea#message";
    const session = new FakeBrowserSession(
      "rules",
      { projectId: "p", profileKey: "k", locale: "de-DE", timezoneId: "Europe/Berlin" },
      {
        "https://board.example/reply": {
          text: "",
          elements: {
            [box]: { checked: false },
            [message]: {},
          },
        },
      },
    );
    await session.goto("https://board.example/reply");
    await driver.fillReply(session, "Kurze Pausen helfen bei Krämpfen.");
    expect(session.actions.some((action) => action.kind === "click" && action.selector === box)).toBe(
      true,
    );
    expect(session.valueOf(message)).toBe("Kurze Pausen helfen bei Krämpfen.");
  });

  it("does not treat a login wall as an open reply", async () => {
    const url = "https://board.example/phpbb/viewtopic.php?t=5";
    const session = new FakeBrowserSession(
      "login-wall",
      { projectId: "p", profileKey: "k", locale: "de-DE", timezoneId: "Europe/Berlin" },
      {
        [url]: {
          text: "Du musst dich anmelden, um in diesem Forum auf Beiträge zu antworten.",
          elements: { "form#login": { text: "Anmelden" } },
        },
      },
    );
    expect(await driver.openReply(session, { url, title: "Fußkrämpfe" })).toBe(false);
  });

  it("builds canonical permalinks", () => {
    expect(phpbbPermalink("http://board.test/forum/viewtopic.php?p=17#p17")).toBe(
      "http://board.test/forum/viewtopic.php?p=17#p17",
    );
    expect(phpbbPermalink("http://board.test/viewtopic.php?t=3&start=10#p42")).toBe(
      "http://board.test/viewtopic.php?p=42#p42",
    );
    expect(phpbbPermalink("http://board.test/viewtopic.php?t=3")).toBeNull();
    expect(driver.registerUrl("http://board.test/forum/index.php?sid=1")).toBe(
      "http://board.test/forum/ucp.php?mode=register",
    );
  });

  it("probes the new-member link rule", () => {
    expect(
      driver.probeLinkRule("New members cannot post links until they have made 5 posts."),
    ).toEqual({ hrefForNewMembers: "after_n_posts", minPosts: 5, relDefault: "unknown" });
    expect(driver.probeLinkRule("Links sind erst nach 10 Beiträgen erlaubt.")).toEqual({
      hrefForNewMembers: "after_n_posts",
      minPosts: 10,
      relDefault: "unknown",
    });
    expect(driver.probeLinkRule("Neue Mitglieder dürfen keine Links posten.")).toEqual({
      hrefForNewMembers: "no",
      minPosts: null,
      relDefault: "unknown",
    });
    expect(driver.probeLinkRule("Be polite.")).toEqual({
      hrefForNewMembers: "unknown",
      minPosts: null,
      relDefault: "unknown",
    });
  });

  it("renders BBCode links safely", () => {
    expect(renderBbcode('[url=https://a.example/x]A & "B"[/url]', "nofollow")).toBe(
      '<a href="https://a.example/x" class="postlink" rel="nofollow">A &amp; &quot;B&quot;</a>',
    );
    expect(renderBbcode("[url=javascript:alert(1)]x[/url]", "ugc")).toBe("x");
    expect(renderBbcode("<b>hi</b>", "follow")).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("normalises link targets", () => {
    expect(normalizeTargetUrl("https://WWW.Example.com/a/?utm_source=x&b=1#top")).toBe(
      "example.com/a?b=1",
    );
    expect(normalizeTargetUrl("ftp://example.com")).toBeNull();
  });
});

describe("logged-out verification", () => {
  const mail: FixtureMail[] = [];
  const fixtures: Array<Awaited<ReturnType<typeof startPhpbbFixture>>> = [];
  const board = async (rel: "follow" | "nofollow" | "ugc") => {
    const fixture = await startPhpbbFixture({ rel, deliverMail: (m) => void mail.push(m) });
    fixtures.push(fixture);
    const id = fixture.seedPost(
      "mira",
      "See [url=https://vereinsplaner.example/mitglieder/]the member guide[/url].",
    );
    return { fixture, id };
  };
  afterAll(async () => {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  });

  it.each([
    ["follow", "live", []],
    ["nofollow", "nofollow_live", ["nofollow"]],
    ["ugc", "nofollow_live", ["ugc"]],
  ] as const)("reports %s links", async (rel, status, relTokens) => {
    const { fixture, id } = await board(rel);
    const result = await verifyPlacement({
      postUrl: `${fixture.origin}/viewtopic.php?p=${id}#p${id}`,
      targetUrl: target,
      allowPrivateNetwork: true,
    });
    expect(result.outcome.status).toBe(status);
    expect(result.outcome.rel).toEqual(relTokens);
    expect(result.anchorText).toBe("the member guide");
    expect(result.html).toContain(`id="p${id}"`);
  });

  it("reports removed links and dead posts", async () => {
    const { fixture } = await board("ugc");
    const removed = await verifyPlacement({
      postUrl: `${fixture.origin}/viewtopic.php?p=1#p1`,
      targetUrl: target,
      allowPrivateNetwork: true,
    });
    expect(removed.outcome.status).toBe("removed");
    const dead = await verifyPlacement({
      postUrl: `${fixture.origin}/viewtopic.php?p=404#p404`,
      targetUrl: target,
      allowPrivateNetwork: true,
    });
    expect(dead.outcome.status).toBe("dead");
  });

  it("refuses private addresses unless allowed", async () => {
    const { fixture, id } = await board("ugc");
    await expect(
      verifyPlacement({
        postUrl: `${fixture.origin}/viewtopic.php?p=${id}#p${id}`,
        targetUrl: target,
      }),
    ).rejects.toBeInstanceOf(VerifyRefused);
    expect(fixture.requests).toHaveLength(0);
  });
});

const persona: BrowserPersona = {
  projectId: "p",
  profileKey: "drivers",
  locale: "en-US",
  timezoneId: "UTC",
};

describe("captcha crop and widgets", () => {
  it("accepts a wide letter captcha and rejects a tiny or square crop", () => {
    expect(TINY_PNG.byteLength).toBeLessThan(100);
    expect(captchaCropAcceptable(TINY_PNG)).toBe(false);
    expect(captchaCropAcceptable(noisePng(160, 48, 1))).toBe(true);
    expect(captchaCropAcceptable(noisePng(40, 40, 1))).toBe(false);
  });

  it("crops closer twice when the picture cannot be read", async () => {
    const wide = noisePng(160, 48, 1);
    const closer = noisePng(140, 40, 2);
    const closest = noisePng(120, 32, 3);
    const session = new FakeBrowserSession("s", persona, {
      "https://board.example/register": {
        elements: {
          "#captcha": { png: wide, closerPngs: [closer, closest] },
          "#answer": { text: "" },
        },
      },
    });
    await session.goto("https://board.example/register");
    const solver = new FakeCaptchaSolver({
      outcomes: [new CaptchaSolverError("not_read"), new CaptchaSolverError("not_read"), "K7XQ2"],
    });
    const solution = await solveImageCaptcha(
      session,
      { imageSelector: "#captcha", answerSelector: "#answer" },
      solver,
      context,
    );
    expect(solution).toMatchObject({ ok: true, answer: "K7XQ2" });
    expect(solver.requests).toHaveLength(3);
    expect(session.screenshots.map((shot) => shot.insetPx)).toEqual([undefined, 8, 16]);
    const images = solver.requests.map((request) =>
      request.type === "ImageToText" ? request.imagePng : new Uint8Array(),
    );
    expect(images[0]).toEqual(wide);
    expect(images[1]).toEqual(closer);
    expect(images[2]).toEqual(closest);
  });

  it("does not type an instruction or send a password question", () => {
    expect(isSecretRegistrationPrompt("Enter the email code")).toBe(true);
    expect(isSecretRegistrationPrompt("Wie heißt die Hauptstadt?")).toBe(false);
    expect(instructionClickSelector("Click Weiter on this form.")).toContain("Weiter");
    expect(instructionClickSelector("Click Login")).toBeNull();
    expect(instructionClickSelector("Type Berlin")).toBeNull();
    expect(isLoginPath("https://board.example/login")).toBe(true);
    expect(isLoginPath("https://board.example/register")).toBe(false);
  });

  it("recognises knowledge questions and widget site keys", async () => {
    expect(looksLikeKnowledgeQuestion("Wie heißt die Hauptstadt von Deutschland?")).toBe(true);
    expect(looksLikeKnowledgeQuestion("What is 7 + 4?")).toBe(true);
    expect(looksLikeKnowledgeQuestion("Username")).toBe(false);
    const session = new FakeBrowserSession("s", persona, {
      "https://board.example/register": {
        elements: {
          "#qa_answer": { text: "" },
          "label[for='qa_answer']": { text: "Wie heißt die Hauptstadt von Deutschland?" },
          ".h-captcha": { attributes: { "data-sitekey": "h-key" } },
          "iframe[src*='recaptcha'][src*='k=']": {
            attributes: { src: "https://www.recaptcha.net/recaptcha/api2/anchor?k=frame-key" },
          },
          "[data-ipsCaptcha-key]": { attributes: { "data-ipsCaptcha-key": "ips-key" } },
        },
      },
      "https://board.example/frame": {
        elements: {
          "iframe[src*='recaptcha'][src*='k=']": {
            attributes: { src: "https://www.google.com/recaptcha/api2/anchor?k=from-frame" },
          },
        },
      },
    });
    await session.goto("https://board.example/register");
    expect(await detectKnowledgeQuestion(session)).toMatchObject({
      kind: "question",
      question: "Wie heißt die Hauptstadt von Deutschland?",
      answerSelector: "#qa_answer",
    });
    expect(await detectWidget(session)).toEqual({
      kind: "widget",
      type: "hcaptcha",
      siteKey: "h-key",
    });
    const xenforo = new FakeBrowserSession("s", persona, {
      "https://board.example/xf": {
        elements: {
          "[data-xf-init='turnstile']": { attributes: { "data-sitekey": "xf-turnstile-key" } },
        },
      },
    });
    await xenforo.goto("https://board.example/xf");
    expect(await detectWidget(xenforo)).toEqual({
      kind: "widget",
      type: "turnstile",
      siteKey: "xf-turnstile-key",
    });
    const xenforoCaptcha = new FakeBrowserSession("s", persona, {
      "https://board.example/xf-h": {
        elements: {
          "[data-xf-init='h-captcha']": { attributes: { "data-sitekey": "xf-hcaptcha-key" } },
        },
      },
    });
    await xenforoCaptcha.goto("https://board.example/xf-h");
    expect(await detectWidget(xenforoCaptcha)).toEqual({
      kind: "widget",
      type: "hcaptcha",
      siteKey: "xf-hcaptcha-key",
    });
    await session.goto("https://board.example/frame");
    expect(await detectWidget(session)).toEqual({
      kind: "widget",
      type: "recaptcha_v2",
      siteKey: "from-frame",
    });
  });

  it("does not submit a Placing button after the injected clock passes the timeout", async () => {
    const session = new FakeBrowserSession("s", persona, {
      "https://board.example/register": {
        elements: {
          "[data-page-helper]": {
            text: HELPER_LABELS.placing,
            onClick: (page) => page.setText("[data-page-helper]", HELPER_LABELS.missingSiteKey),
          },
          "#submit": { text: "Submit" },
        },
      },
    });
    await session.goto("https://board.example/register");
    let now = 0;
    const run = await runPageHelper(session, {
      buttonSelector: "[data-page-helper]",
      submitSelector: "#submit",
      pageMessages: async () => [],
      now: () => now,
      sleep: async () => {
        now += HELPER_PLACING_TIMEOUT_MS + 1;
      },
      pollMs: 1,
    });
    expect(run.decision.action).toBe("stop_host");
    expect(run.decision.reason).toBe("missing_site_key");
    expect(
      session.actions.some((action) => action.kind === "click" && action.selector === "#submit"),
    ).toBe(false);
  });
});

const gate = browserTestGate();

describe.skipIf(!gate.available)(
  `phpBB driver in Chromium${gate.reason ? ` (${gate.reason})` : ""}`,
  () => {
    const mail: FixtureMail[] = [];
    let fixture: Awaited<ReturnType<typeof startPhpbbFixture>>;
    let root = "";
    let session: BrowserSession;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "rakazo-lb-drivers-"));
      fixture = await startPhpbbFixture({
        rel: "ugc",
        cookieWall: true,
        linkRuleMinPosts: 0,
        deliverMail: (m) => void mail.push(m),
      });
      const factory = new LocalBrowserSessionFactory({
        profileRoot: root,
        helperDirs: [FIXTURE_PAGE_HELPER_DIR],
        headless: true,
        pacing: TEST_PACING,
        env: { LINK_BUILDER_BROWSER: "local" },
      });
      session = await factory.open(
        { projectId: "p", profileKey: "drivers", locale: "en-US", timezoneId: "UTC" },
        context,
      );
    });

    afterAll(async () => {
      await session?.close();
      await fixture?.close();
      await rm(root, { recursive: true, force: true });
    });

    it("registers, activates, logs in and replies with a link", async () => {
      await session.goto(fixture.origin);
      expect(await acceptCookieWall(session)).toBe("accepted");
      expect(await acceptCookieWall(session)).toBe("none");

      expect(await driver.openRegistration(session, fixture.origin)).toBe("form");
      const account = {
        username: "mira_sol42",
        password: "Fx-Pass-Word-77",
        email: "mira@inbox.example",
      };
      await driver.fillRegistration(session, account);
      const challenge = await driver.detectCaptcha(session);
      expect(challenge.kind).toBe("image");
      if (challenge.kind !== "image") return;

      const wrong = new FakeCaptchaSolver({ outcomes: ["WRONG"] });
      await solveImageCaptcha(session, challenge, wrong, context);
      expect(await driver.submitRegistration(session)).toEqual({ kind: "captcha_rejected" });

      await driver.fillRegistration(session, account);
      const solver = new FakeCaptchaSolver({ outcomes: ["K7XQ2"] });
      const solution = await solveImageCaptcha(session, challenge, solver, context);
      expect(solution.ok).toBe(true);
      if (!solution.ok) return;
      expect(solution.credits).toBeGreaterThan(0);
      const request = solver.requests[0];
      expect(request?.type === "ImageToText" && request.imagePng.byteLength).toBeGreaterThanOrEqual(
        100,
      );
      expect(await driver.submitRegistration(session)).toEqual({ kind: "pending_email" });

      expect(mail).toHaveLength(1);
      const link = /https?:\/\/\S+mode=activate\S+/.exec(mail[0]!.textBody)?.[0];
      await session.goto(link!);
      expect(await driver.activationResult(session)).toBe("active");

      expect(await driver.login(session, fixture.origin, account)).toBe(true);
      const threads = await driver.listThreads(session, fixture.origin);
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({ replyCount: 0 });
      expect(await driver.openReply(session, threads[0]!)).toBe(true);
      expect(driver.probeLinkRule(await session.pageText()).hrefForNewMembers).toBe(
        "after_n_posts",
      );
      await driver.fillReply(
        session,
        "We use a hosted planner. [url=https://vereinsplaner.example/mitglieder]member guide[/url]",
      );
      const reply = await driver.submitReply(session);
      expect(reply).toEqual({
        kind: "posted",
        permalink: `${fixture.origin}/viewtopic.php?p=2#p2`,
      });
      expect(fixture.users.get("mira_sol42")?.postCount).toBe(1);
    });

    it.each([
      ["ok", "submit", HELPER_LABELS.placed],
      ["no_token", "submit", HELPER_LABELS.placed],
      ["missing_key", "stop_host", HELPER_LABELS.missingSiteKey],
      ["unsupported", "stop_host", HELPER_LABELS.unsupportedType],
    ] as const)(
      "runs the Page Helper state machine on the %s widget",
      async (fixtureCase, action, label) => {
        await session.goto(`${fixture.origin}/widget.php?case=${fixtureCase}`);
        expect(await session.waitFor("[data-page-helper]", { timeoutMs: 10_000 })).toBe(true);
        const challenge = await driver.detectCaptcha(session);
        expect(challenge).toMatchObject({ kind: "widget", type: "recaptcha_v2" });
        const run = await runPageHelper(session, {
          buttonSelector: "[data-page-helper]",
          submitSelector: "#widget-submit",
          pageMessages: (s) => driver.pageMessages(s),
          pollMs: 50,
        });
        expect(run.decision.action).toBe(action);
        expect(run.buttonText).toBe(label);
        if (action === "submit") {
          expect(run.decision.outcome).toBe("placed_submitted");
          expect(await session.text("div#message")).toContain("the form was accepted");
          expect(run.decision.tries).toBe(fixtureCase === "no_token" ? 2 : 1);
        } else {
          expect(run.decision.hostEvent).toBe("unsupported_captcha");
        }
      },
    );

    it("screenshots the helper once the check is placed", async () => {
      await session.goto(`${fixture.origin}/widget.php?case=ok`);
      expect(await session.waitFor("[data-page-helper]", { timeoutMs: 10_000 })).toBe(true);
      await session.click("[data-page-helper]");
      await expect
        .poll(() => session.text("[data-page-helper]"), { timeout: 5_000 })
        .toBe(HELPER_LABELS.placed);
      const png = await session.screenshotPng();
      await mkdir("/opt/cursor/artifacts", { recursive: true });
      await writeFile("/opt/cursor/artifacts/page-helper-placed.png", png);
      expect(png.byteLength).toBeGreaterThan(100);
    });

    it("does not send a captcha image that stays under 100 bytes or the wrong shape", async () => {
      const tiny = await startPhpbbFixture({
        captchaImage: "tiny",
        cookieWall: false,
        deliverMail: () => undefined,
      });
      try {
        await session.goto(tiny.origin);
        expect(await driver.openRegistration(session, tiny.origin)).toBe("form");
        const challenge = await driver.detectCaptcha(session);
        expect(challenge.kind).toBe("image");
        if (challenge.kind !== "image") return;
        const solver = new FakeCaptchaSolver();
        await expect(solveImageCaptcha(session, challenge, solver, context)).resolves.toEqual({
          ok: false,
          reason: "crop_rejected",
        });
        expect(solver.requests).toHaveLength(0);
      } finally {
        await tiny.close();
      }
    });

    it("crops closer when the image cannot be read, then types the answer", async () => {
      const board = await startPhpbbFixture({ cookieWall: false, deliverMail: () => undefined });
      try {
        await session.goto(board.origin);
        expect(await driver.openRegistration(session, board.origin)).toBe("form");
        const challenge = await driver.detectCaptcha(session);
        expect(challenge.kind).toBe("image");
        if (challenge.kind !== "image") return;
        const solver = new FakeCaptchaSolver({
          outcomes: [new CaptchaSolverError("not_read"), "K7XQ2"],
        });
        const solution = await solveImageCaptcha(session, challenge, solver, context);
        expect(solution).toMatchObject({ ok: true, answer: "K7XQ2" });
        expect(solver.requests).toHaveLength(2);
        const first = solver.requests[0];
        const second = solver.requests[1];
        expect(first?.type).toBe("ImageToText");
        expect(second?.type).toBe("ImageToText");
        if (first?.type === "ImageToText" && second?.type === "ImageToText") {
          const before = pngDimensions(first.imagePng);
          const after = pngDimensions(second.imagePng);
          expect(before).not.toBeNull();
          expect(after).not.toBeNull();
          expect(after!.width).toBeLessThan(before!.width);
          expect(after!.height).toBeLessThan(before!.height);
        }
      } finally {
        await board.close();
      }
    });
  },
);
