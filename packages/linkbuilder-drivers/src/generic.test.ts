import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { BrowserSession, FormFieldInfo } from "@rakazo/adapter-kit";
import { UnmappedFormError } from "./driver.js";
import {
  arrangeSortableCaptcha,
  GenericFormDriver,
  planRegistration,
  registrationProfile,
} from "./generic.js";
import { startCustomForumFixture } from "./testing/custom-forum-fixture.js";
import { HtmlBrowserSession } from "./testing/html-session.js";

describe("generic form driver", () => {
  it("maps a labelled form and refuses an ambiguous one", async () => {
    const fixture = await startCustomForumFixture();
    const driver = new GenericFormDriver();
    const session = new HtmlBrowserSession();
    try {
      expect(driver.detect()).toBe(false);
      expect(await driver.openRegistration(session, fixture.origin)).toBe("form");
      await driver.fillRegistration(session, {
        username: "mira_sol42",
        email: "mira@inbox.example",
        password: "Fx-Pass-Word-77",
      });
      expect((await driver.submitRegistration(session)).kind).toBe("pending_email");
      expect(
        await driver.login(session, fixture.origin, {
          username: "mira_sol42",
          password: "Fx-Pass-Word-77",
        }),
      ).toBe(true);
      expect(
        await driver.setProfile(session, fixture.origin, {
          bio: "Mira Sol",
          signature: "https://tips.example/guide",
          includeSignature: false,
        }),
      ).toBe(true);
      expect(fixture.profile()).toEqual({ bio: "Mira Sol", signature: "" });
      const threads = await driver.listThreads(session, fixture.origin);
      expect(threads[0]?.openQuestion).toBe(true);
      expect((await driver.probePageLinkRule(session)).relDefault).toBe("ugc");
      expect(driver.probeLinkRule(await session.pageText())).toMatchObject({
        hrefForNewMembers: "after_n_posts",
        minPosts: 2,
      });
      expect(await driver.openReply(session, threads[0]!)).toBe(true);
      await driver.fillReply(
        session,
        "A shared list is easier for the committee than a spreadsheet.",
      );
      const reply = await driver.submitReply(session);
      expect(reply.kind).toBe("posted");
      if (reply.kind === "posted") expect(reply.permalink).toContain("/thread/1#post1");

      await session.goto(`${fixture.origin}/register?case=odd`);
      expect(await driver.mapOpenRegistration(session)).toBe("unmapped");
      await expect(
        driver.openReply(session, { url: `${fixture.origin}/thread/2`, title: "Odd" }),
      ).rejects.toBeInstanceOf(UnmappedFormError);
    } finally {
      await fixture.close();
    }
  });

  it("reads a XenForo confirmation behind the browser warning", async () => {
    const driver = new GenericFormDriver();
    const confirmation =
      "Danke. Eine E-Mail wurde an sophie@inbox.example gesendet. Bitte klicke auf den Link.";
    const session = xenforoPage(
      [
        "JavaScript ist deaktiviert. Für eine bessere Darstellung aktiviere bitte JavaScript in deinem Browser, bevor du fortfährst.",
        "Du verwendest einen veralteten Browser. Es ist möglich, dass diese oder andere Websites nicht korrekt angezeigt werden.",
        confirmation,
      ],
      [field({ selector: "#q", name: "keywords", label: "Suche" })],
    );
    expect(await driver.pageMessages(session)).toEqual([confirmation]);
    expect(await driver.readRegistrationResult(session)).toEqual({ kind: "pending_email" });
  });

  it("keeps the XenForo form error and drops the browser warning", async () => {
    const driver = new GenericFormDriver();
    const refusal = "Der Benutzername ist bereits vergeben.";
    const session = xenforoPage(
      [
        "Du verwendest einen veralteten Browser.",
        refusal,
      ],
      [
        field({
          selector: "#real-user",
          name: "hasheduser",
          label: "Benutzername",
          autocomplete: "username",
          required: true,
        }),
        field({
          selector: "#email",
          name: "hashedmail",
          type: "email",
          label: "E-Mail",
          autocomplete: "email",
          required: true,
        }),
        field({
          selector: "#password",
          name: "hashedpass",
          type: "password",
          label: "Passwort",
          autocomplete: "new-password",
          required: true,
        }),
        field({ selector: "#submit", tag: "button", type: "submit", label: "Registrieren" }),
      ],
    );
    const result = await driver.readRegistrationResult(session);
    expect(result).toEqual({ kind: "form_error", messages: [refusal] });
  });

  it("checks every required consent box", () => {
    const plan = planRegistration(
      [
        field({ selector: "#user", name: "username", label: "Benutzername", required: true }),
        field({ selector: "#email", type: "email", label: "E-Mail", required: true }),
        field({
          selector: "#password",
          type: "password",
          label: "Passwort",
          autocomplete: "new-password",
          required: true,
        }),
        field({ selector: "#rules", type: "checkbox", name: "accept_rules", label: "Regeln", required: true }),
        field({
          selector: "#terms",
          type: "checkbox",
          name: "accept_terms",
          label: "Bedingungen",
          required: true,
        }),
        field({ selector: "#submit", tag: "button", type: "submit", label: "Registrieren" }),
      ],
      registrationProfile({
        username: "sophie_braun",
        email: "sophie@example.com",
        password: "example-password",
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.actions.filter((action) => action.kind === "click").map((action) => action.selector)).toEqual([
      "#rules",
      "#terms",
    ]);
  });

  it("maps the diabetes-forum register form", () => {
    const plan = planRegistration(
      [
        field({ selector: "#Name", name: "Name", label: "Benutzername *", required: true }),
        field({ selector: "#DisplayName", name: "DisplayName", label: "Anzeigename *", required: true }),
        field({ selector: "#Email", name: "Email", label: "Deine Email-Adresse *", required: true }),
        field({ selector: "#Passwort", name: "Passwort", type: "password", label: "Kennwort *", required: true }),
        field({
          selector: "#Passwort2",
          name: "Passwort2",
          type: "password",
          label: "Kennwortwiederholung *",
          required: true,
        }),
        field({ selector: "#verify", name: "verify", label: "Überprüfungscode *", required: true }),
        field({
          selector: "#agb",
          name: "agb",
          type: "checkbox",
          label: "Nutzungsbedingungen *",
          required: true,
        }),
        field({ selector: "#go", tag: "button", type: "submit", label: "Registrierung Absenden" }),
      ],
      registrationProfile({
        username: "sophie_braun",
        email: "sophie@example.com",
        password: "example-password",
      }),
    );
    if (!plan.ok) throw new Error(`${plan.reason} ${plan.label ?? ""}`);
    expect(plan.submit.selector).toBe("#go");
  });

  it("submits Registrierung Absenden when a search button is also on the page", () => {
    const plan = planRegistration(
      [
        field({ selector: "#user", name: "UserName", label: "Benutzername", required: true }),
        field({ selector: "#email", name: "Email", label: "Email-Adresse", required: true }),
        field({
          selector: "#password",
          name: "Passwort",
          type: "password",
          label: "Kennwort",
          required: true,
        }),
        field({ selector: "#menu", tag: "button", label: "" }),
        field({ selector: "#search", tag: "button", type: "submit", label: "Suche starten" }),
        field({
          selector: "#go",
          tag: "button",
          type: "submit",
          label: "Registrierung Absenden",
        }),
      ],
      registrationProfile({
        username: "sophie_braun",
        email: "sophie@example.com",
        password: "example-password",
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.submit.selector).toBe("#go");
  });

  it("maps the WinFuture registration fields", () => {
    const plan = planRegistration(
      [
        field({
          selector: "#login_name",
          name: "UserName",
          label: "Wähle einen Benutzernamen",
          required: true,
        }),
        field({
          selector: "#email_1",
          name: "EmailAddress",
          label: "Gib deine E-Mail Adresse ein",
          required: true,
        }),
        field({
          selector: "#email_2",
          name: "EmailAddress_two",
          label: "E-Mail Adresse wiederholen",
          required: true,
        }),
        field({
          selector: "#password_1",
          name: "PassWord",
          type: "password",
          label: "Wähle dein Passwort",
          required: true,
        }),
        field({
          selector: "#password_2",
          name: "PassWord_Check",
          type: "password",
          label: "Passwort wiederholen",
          required: true,
        }),
        field({
          selector: "#field_25_1",
          name: "field_25[1]",
          type: "checkbox",
          label: "AGB und Datenschutz Ja, Ich stimme den oben verlinkten AGB und Datenschutzbestimmungen zu.",
          required: true,
        }),
        field({ selector: "#submit", tag: "button", type: "submit", label: "Registrieren" }),
      ],
      registrationProfile({
        username: "sophie_braun",
        email: "sophie@example.com",
        password: "example-password",
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const filled = plan.actions.filter((action) => action.kind === "fill").map((action) => action.selector);
    expect(filled).toEqual(["#login_name", "#email_1", "#password_1", "#password_2", "#email_2"]);
    expect(plan.actions.some((action) => action.kind === "click" && action.selector === "#field_25_1")).toBe(
      true,
    );
  });

  it("treats a repeated email address as the confirmation", () => {
    const plan = planRegistration(
      [
        field({ selector: "#user", name: "username", label: "Benutzername", required: true }),
        field({
          selector: "#email",
          type: "email",
          label: "E-Mail",
          required: true,
        }),
        field({
          selector: "#email2",
          type: "email",
          label: "E-Mail Adresse wiederholen",
          required: true,
        }),
        field({
          selector: "#password",
          type: "password",
          label: "Passwort",
          autocomplete: "new-password",
          required: true,
        }),
        field({ selector: "#submit", tag: "button", type: "submit", label: "Registrieren" }),
      ],
      registrationProfile({
        username: "sophie_braun",
        email: "sophie@example.com",
        password: "example-password",
      }),
    );
    expect(plan.ok).toBe(true);
  });

  it("picks the required email when a second email field is optional", () => {
    const plan = planRegistration(
      [
        field({
          selector: "#user",
          name: "username",
          label: "Benutzername",
          required: true,
        }),
        field({
          selector: "#email-decoy",
          name: "email",
          type: "email",
          label: "E-Mail",
          autocomplete: "email",
        }),
        field({
          selector: "#email",
          name: "email_address",
          type: "email",
          label: "E-Mail",
          autocomplete: "email",
          required: true,
        }),
        field({
          selector: "#password",
          type: "password",
          label: "Passwort",
          autocomplete: "new-password",
          required: true,
        }),
        field({ selector: "#submit", tag: "button", type: "submit", label: "Registrieren" }),
      ],
      registrationProfile({
        username: "sophie_braun",
        email: "sophie@example.com",
        password: "example-password",
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.actions.find((action) => action.selector === "#email")).toMatchObject({
      value: "sophie@example.com",
    });
  });

  it("maps a XenForo register form and ignores the username decoy", () => {
    const plan = planRegistration(
      [
        field({ selector: "[name='username']", name: "username", label: "Benutzername" }),
        field({
          selector: "#real-user",
          name: "hasheduser",
          label: "Benutzername",
          autocomplete: "username",
          required: true,
        }),
        field({
          selector: "#email",
          name: "hashedmail",
          type: "email",
          label: "E-Mail",
          autocomplete: "email",
          required: true,
        }),
        field({
          selector: "#password",
          name: "hashedpass",
          type: "password",
          label: "Passwort",
          autocomplete: "new-password",
          required: true,
        }),
        field({
          selector: "#accept",
          name: "accept",
          type: "checkbox",
          label: "Nutzungsbedingungen",
          value: "1",
          required: true,
        }),
        field({ selector: "[name='dob_day']", name: "dob_day", label: "" }),
        field({
          selector: "#version",
          tag: "select",
          name: "custom_fields[xf_version][]",
          label: "XF Version",
        }),
        field({ selector: "#submit", tag: "button", type: "submit", label: "Registrieren" }),
      ],
      registrationProfile({
        username: "sophie_braun95",
        email: "sophie@inbox.example",
        password: "Fx-Pass-Word-77",
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.actions.map((action) => action.selector)).toEqual([
      "#real-user",
      "#email",
      "#password",
      "#accept",
    ]);
  });

  it("moves decoys out of the phpBB property list before submit", async () => {
    const board = await startSortableQuestionBoard();
    const session = new HtmlBrowserSession();
    try {
      await session.goto(board.origin);
      await arrangeSortableCaptcha(session);
      const html = session.html();
      const matching = html.slice(html.indexOf('id="sortable1"'), html.indexOf('id="sortable2"'));
      const other = html.slice(html.indexOf('id="sortable2"'));
      expect(matching).toContain("Deutschsprachig");
      expect(matching).toContain("phpBB-Download");
      expect(matching).not.toContain("Dating Website");
      expect(other).toContain("Dating Website");
      expect(other).toContain("Crypto Währung");
    } finally {
      await board.close();
    }
  });

  it("sorts vegetables out of the fruit list", async () => {
    const board = await startSortableQuestionBoard(`<!DOCTYPE html><html><body>
<p>Ordne hier Obst / Gemüse richtig zu.</p>
<h3>Obst</h3>
<ul id="sortable1">
  <li>Zucchini</li><li>Birne</li><li>Paprika</li><li>Banane</li><li>Tomate</li><li>Karotte</li><li>Apfel</li>
</ul>
<h3>Gemüse</h3>
<ul id="sortable2"></ul>
</body></html>`);
    const session = new HtmlBrowserSession();
    try {
      await session.goto(board.origin);
      await arrangeSortableCaptcha(session);
      const html = session.html();
      const fruit = html.slice(html.indexOf('id="sortable1"'), html.indexOf('id="sortable2"'));
      const vegetables = html.slice(html.indexOf('id="sortable2"'));
      expect(fruit).toContain("Apfel");
      expect(fruit).toContain("Banane");
      expect(fruit).not.toContain("Zucchini");
      expect(vegetables).toContain("Tomate");
      expect(vegetables).toContain("Karotte");
    } finally {
      await board.close();
    }
  });

  it("fills a starred custom field the plan does not know", async () => {
    const board = await startSortableQuestionBoard(`<!DOCTYPE html><html><body>
<form id="register" method="post" action="/register">
<label for="username">Benutzername</label><input id="username" name="username">
<label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email">
<label for="new_password">Passwort</label><input id="new_password" name="new_password" type="password">
<label for="extra">Aufbauart/Ausstattung: *</label><input id="extra" name="pf_zusatz">
<input type="submit" id="submit" name="submit" value="Absenden">
</form>
</body></html>`);
    const session = new HtmlBrowserSession();
    const driver = new GenericFormDriver();
    try {
      await session.goto(board.origin);
      await driver.fillRegistration(session, {
        username: "sophie_braun99",
        email: "sophie@inbox.example",
        password: "Fx-Pass-Word-77",
      });
      expect(await session.attribute("#extra", "value")).toBe("keine");
    } finally {
      await board.close();
    }
  });

  it("clicks the header register link and only then reads the form", async () => {
    const board = await startHeaderRegisterLinkBoard();
    const driver = new GenericFormDriver();
    const session = new HtmlBrowserSession();
    try {
      expect(await driver.openRegistration(session, board.origin)).toBe("form");
      expect(await session.url()).toContain("/mitglied");
      expect(board.sawHome).toBe(true);
    } finally {
      await board.close();
    }
  });

  it("does not type into a field the page says to leave empty", async () => {
    const board = await startDecoyNameBoard();
    const driver = new GenericFormDriver();
    const session = new HtmlBrowserSession();
    try {
      await session.goto(board.origin);
      const fields = await session.formFields("form");
      const decoy = fields.find((field) => field.name === "username");
      const real = fields.find((field) => field.autocomplete === "username");
      expect(decoy?.hidden).toBe(true);
      expect(real?.hidden).toBe(false);
      await driver.fillRegistration(session, {
        username: "sophiebraun",
        email: "sophie@inbox.example",
        password: "Fx-Pass-Word-77",
      });
      expect(await session.attribute("#real-user", "value")).toBe("sophiebraun");
      expect(await session.attribute("#decoy-user", "value")).toBeNull();
    } finally {
      await board.close();
    }
  });

  it("follows the header link beside login when the words are not Register", async () => {
    const board = await startNamedRegisterLinkBoard();
    const driver = new GenericFormDriver();
    const session = new HtmlBrowserSession();
    try {
      expect(await driver.openRegistration(session, board.origin)).toBe("form");
      expect(await session.url()).toContain("/mitmachen");
    } finally {
      await board.close();
    }
  });

  it("passes a German terms gate that sits behind the search form", async () => {
    const board = await startSearchThenAgreementBoard();
    const driver = new GenericFormDriver();
    const session = new HtmlBrowserSession();
    try {
      expect(await driver.openRegistration(session, board.origin)).toBe("form");
      await driver.fillRegistration(session, {
        username: "sophie_braun95",
        email: "sophie@inbox.example",
        password: "Fx-Pass-Word-77",
      });
      expect((await driver.submitRegistration(session)).kind).toBe("pending_email");
      expect(board.acceptedTerms).toBe(true);
      expect(board.registeredAs).toBe("sophie_braun95");
    } finally {
      await board.close();
    }
  });

  it("skips a locked topic and reads the thread list once", async () => {
    const board = await startLockedTopicBoard();
    const driver = new GenericFormDriver();
    const session = new HtmlBrowserSession();
    let attributeCalls = 0;
    const attribute = session.attribute.bind(session);
    session.attribute = async (selector, name) => {
      attributeCalls += 1;
      return attribute(selector, name);
    };
    try {
      const threads = await driver.listThreads(session, board.origin);
      expect(attributeCalls).toBe(0);
      expect(threads.map((thread) => thread.title)).toEqual(["Gesperrtes Thema", "Offene Frage?"]);
      expect(await driver.openReply(session, threads[0]!)).toBe(false);
      expect(await driver.openReply(session, threads[1]!)).toBe(true);
      await driver.fillReply(session, "Danke für den Hinweis, das hatte ich ähnlich erlebt.");
      expect((await session.text("#message")).trim()).toBe(
        "Danke für den Hinweis, das hatte ich ähnlich erlebt.",
      );
    } finally {
      await board.close();
    }
  });
});

function startLockedTopicBoard(): Promise<{ origin: string; close: () => Promise<void> }> {
  const locked =
    "<p>Dieses Thema ist gesperrt. Du kannst keine Beiträge editieren oder weitere Antworten erstellen.</p>";
  const replyForm = `<form id="postform" action="/posting">
    <textarea name="message" id="message"></textarea>
    <button type="button">B</button>
    <input type="submit" name="preview" value="Vorschau">
    <input type="submit" name="post" value="Absenden">
  </form>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body =
      url.pathname === "/locked"
        ? `<p><a href="/posting?mode=reply&t=locked">Antworten</a></p>`
        : url.pathname === "/open"
          ? `<p><a href="/posting?mode=reply&t=open">Antworten</a></p>`
          : url.pathname === "/posting" && url.searchParams.get("t") === "open"
            ? replyForm
            : url.pathname === "/posting"
              ? locked
              : `<ul>
                  <li class="row"><a class="topictitle" href="/locked">Gesperrtes Thema</a></li>
                  <li class="row"><a class="topictitle" href="/open">Offene Frage?</a></li>
                </ul>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>board</title>${body}`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function startSortableQuestionBoard(
  page = `<!DOCTYPE html><html><body>
<p>Welche Eigenschaften passen zu www.phpBB.de?</p>
<p>Zieh die richtigen Optionen in die korrekte Liste.</p>
<h3>Passen zu phpBB.de</h3>
<ul id="sortable1">
  <li>Deutschsprachig</li>
  <li>Dating Website</li>
  <li>Deutsche Übersetzung</li>
  <li>Supportforum</li>
  <li>phpBB-Download</li>
  <li>Crypto Währung</li>
</ul>
<h3>Passen NICHT zu phpBB.de</h3>
<ul id="sortable2"></ul>
</body></html>`,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(page);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function startHeaderRegisterLinkBoard(): Promise<{
  origin: string;
  sawHome: boolean;
  close: () => Promise<void>;
}> {
  let sawHome = false;
  const home = `<!DOCTYPE html><html><body>
<header><nav><a href="/mitglied">Registrieren</a><a href="/login">Anmelden</a></nav></header>
<form id="search" action="/search" method="get"><input type="text" name="keywords" aria-label="Search"><input type="submit" value="Suche"></form>
</body></html>`;
  const form = `<!DOCTYPE html><html><body>
<form id="register" method="post" action="/mitglied">
<label for="username">Benutzername</label><input id="username" name="username" type="text">
<label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email">
<label for="new_password">Passwort</label><input id="new_password" name="new_password" type="password">
<input type="submit" name="go" value="Registrieren">
</form>
</body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = url.pathname === "/mitglied" ? form : home;
    if (url.pathname === "/") sawHome = true;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        get sawHome() {
          return sawHome;
        },
        close: () =>
          new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function xenforoPage(messages: string[], fields: FormFieldInfo[]): BrowserSession {
  return {
    listText: async () => messages,
    text: async () => messages[0] ?? null,
    exists: async () => true,
    formFields: async () => fields,
  } as unknown as BrowserSession;
}

function field(partial: Partial<FormFieldInfo> & Pick<FormFieldInfo, "selector">): FormFieldInfo {
  return {
    tag: "input",
    type: "text",
    name: null,
    id: null,
    autocomplete: null,
    label: "",
    role: null,
    required: false,
    ...partial,
  };
}

function page(title: string, content: string): string {
  return `<!DOCTYPE html><html><body><h1>${title}</h1>${content}</body></html>`;
}

function startDecoyNameBoard(): Promise<{ origin: string; close: () => Promise<void> }> {
  const html = `<!DOCTYPE html><html><body>
<form method="post" action="/register">
<dl class="formRow formRow--limited"><label for="decoy-user">Benutzername</label>
<input id="decoy-user" name="username" autocomplete="off"><div>Bitte lasse dieses Feld frei.</div></dl>
<dl class="formRow"><label for="real-user">Benutzername</label>
<input id="real-user" name="hashed" autocomplete="username" required></dl>
<label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="email">
<label for="password">Passwort</label><input id="password" name="pass" type="password" autocomplete="new-password">
<button type="submit">Registrieren</button>
</form></body></html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function startNamedRegisterLinkBoard(): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const home = `<!DOCTYPE html><html><body>
<header><nav>
<a href="/faq">FAQ</a>
<a href="/mitmachen">Jetzt mitmachen</a>
<a href="/login">Anmelden</a>
</nav></header>
</body></html>`;
  const form = `<!DOCTYPE html><html><body>
<form id="register" method="post" action="/mitmachen">
<label for="username">Benutzername</label><input id="username" name="username" type="text">
<label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email">
<label for="new_password">Passwort</label><input id="new_password" name="new_password" type="password">
<input type="submit" name="go" value="Registrieren">
</form>
</body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(url.pathname === "/mitmachen" ? form : home);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function startSearchThenAgreementBoard(): Promise<{
  origin: string;
  acceptedTerms: boolean;
  registeredAs: string | null;
  close: () => Promise<void>;
}> {
  let acceptedTerms = false;
  let registeredAs: string | null = null;
  const search = `<form id="search" action="/search" method="get"><input type="text" name="keywords" aria-label="Search"><input type="submit" value="Search"></form>`;
  const agreement = `<form id="agreement" method="post" action="/ucp.php?mode=register">
<p>Bitte lies die Bedingungen. Der Aktivierungsschlüssel wird per E-Mail geschickt.</p>
<input type="submit" name="terms_yes" value="Ich bin mit diesen Bedingungen einverstanden">
<input type="submit" name="terms_no" value="Ich bin mit diesen Bedingungen nicht einverstanden">
</form>`;
  const registration = `<form id="register" method="post" action="/ucp.php?mode=register">
<label for="username">Benutzername</label><input id="username" name="username" type="text">
<label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email">
<label for="new_password">Passwort</label><input id="new_password" name="new_password" type="password">
<label for="password_confirm">Passwort bestätigen</label><input id="password_confirm" name="password_confirm" type="password">
<input type="submit" name="preview" value="Vorschau">
<input type="submit" name="go" value="Registrieren">
</form>`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/ucp.php") {
      const body = await readBody(request);
      const form = new URLSearchParams(body);
      if (form.has("terms_yes")) acceptedTerms = true;
      if (form.get("go") === "Registrieren") {
        registeredAs = form.get("username");
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          page(
            "Information",
            `<div id="message"><p>An activation key has been sent to the email address you provided.</p></div>`,
          ),
        );
        return;
      }
    }
    const content = acceptedTerms ? `${search}${registration}` : `${search}${agreement}`;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(page("Register", content));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        get acceptedTerms() {
          return acceptedTerms;
        },
        get registeredAs() {
          return registeredAs;
        },
        close: () =>
          new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
