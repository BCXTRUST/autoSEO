import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { answerBoardQuestion } from "./captcha.js";
import { platformSuite } from "./platform-suite.js";
import { HtmlBrowserSession } from "./testing/html-session.js";
import { startWoltlabFixture } from "./testing/woltlab-fixture.js";
import {
  newestWoltlabPostId,
  WoltlabDriver,
  woltlabPermalink,
  woltlabPermalinkForPost,
} from "./woltlab.js";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("answerBoardQuestion", () => {
  it("solves the subtraction question and the sky hint", () => {
    expect(answerBoardQuestion("Du hast 10 Äpfel und isst 7 auf, wie viele hast Du noch?")).toBe(
      "3",
    );
    expect(
      answerBoardQuestion("Du hast 10 Orangen und bekommst 5 weitere. Wie viel hast Du jetzt?"),
    ).toBe("15");
    expect(
      answerBoardQuestion("Welche Farbe hat der wolkenlose Himmel im Sommer? (Tipp: bl..)"),
    ).toBe("blau");
    expect(answerBoardQuestion("What is your password?")).toBeNull();
  });
});

describe("woltlab login", () => {
  it("does not post a lost-password form", async () => {
    const form = `<!DOCTYPE html><html><body>
<form id="loginForm" method="post" action="/lost-password/">
<input id="username" name="username" type="text">
<input id="captchaAnswer" name="captchaAnswer" type="text">
<input type="submit" value="Absenden">
</form>
</body></html>`;
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") posts += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(form);
    });
    const origin = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/`);
      });
    });
    const session = new HtmlBrowserSession();
    try {
      expect(
        await new WoltlabDriver().login(session, origin, {
          username: "member",
          password: "secret-value",
        }),
      ).toBe(false);
      expect(posts).toBe(0);
    } finally {
      await new Promise((doneClose, reject) =>
        server.close((error) => (error ? reject(error) : doneClose())),
      );
    }
  });

  it("signs in when the form id is loginForm", async () => {
    const form = `<!DOCTYPE html><html><body>
<form id="loginForm" method="post" action="/login/">
<input id="username" name="username" type="text">
<input id="password" name="password" type="password">
<input type="submit" value="Anmelden">
</form>
</body></html>`;
    const done = `<!DOCTYPE html><html><body><a href="/index.php?logout/">Abmelden</a></body></html>`;
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(request.method === "POST" ? done : form);
    });
    const origin = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/`);
      });
    });
    const session = new HtmlBrowserSession();
    try {
      expect(
        await new WoltlabDriver().login(session, origin, {
          username: "member",
          password: "secret-value",
        }),
      ).toBe(true);
    } finally {
      await new Promise((doneClose, reject) =>
        server.close((error) => (error ? reject(error) : doneClose())),
      );
    }
  });

  it("answers the question that appears after the first submit", async () => {
    const form = `<!DOCTYPE html><html><body>
<form id="loginForm" method="post" action="/login/">
<input id="username" name="username" type="text">
<input id="password" name="password" type="password">
<input type="submit" value="Anmelden">
</form>
<p class="error">Deine Angaben sind ungültig.</p>
</body></html>`;
    const asked = `<!DOCTYPE html><html><body>
<form id="loginForm" method="post" action="/login/">
<label for="username">Benutzername</label>
<input id="username" name="username" type="text">
<input id="password" name="password" type="password">
<label for="captchaAnswer">Du hast 10 Orangen und isst 5 auf, wie viele hast Du noch?</label>
<input id="captchaAnswer" name="captchaAnswer" type="text">
<input type="submit" value="Anmelden">
</form>
</body></html>`;
    const done = `<!DOCTYPE html><html><body><a href="/index.php?logout/">Abmelden</a></body></html>`;
    const server = createServer(async (request, response) => {
      const body = request.method === "POST" ? await readBody(request) : "";
      response.writeHead(200, { "content-type": "text/html" });
      if (request.method === "POST" && new URLSearchParams(body).get("captchaAnswer") === "5") {
        response.end(done);
        return;
      }
      response.end(request.method === "POST" ? asked : form);
    });
    const origin = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/`);
      });
    });
    const session = new HtmlBrowserSession();
    try {
      expect(
        await new WoltlabDriver().login(session, origin, {
          username: "member",
          password: "secret-value",
        }),
      ).toBe(true);
    } finally {
      await new Promise((doneClose, reject) =>
        server.close((error) => (error ? reject(error) : doneClose())),
      );
    }
  });

  it("releases a form hold before opening the login page", async () => {
    let held = true;
    const form = `<!DOCTYPE html><html><body>
<form id="loginForm" method="post" action="/login/">
<input id="username" name="username" type="text">
<input id="password" name="password" type="password">
<input type="submit" value="Anmelden">
</form>
</body></html>`;
    const done = `<!DOCTYPE html><html><body><a class="userMenuItemLink" href="/account-management/">Konto</a></body></html>`;
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(request.method === "POST" ? done : form);
    });
    const origin = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/`);
      });
    });
    const inner = new HtmlBrowserSession();
    const open = inner.goto.bind(inner);
    const session = Object.assign(inner, {
      async releaseForm() {
        held = false;
      },
      async goto(url: string) {
        if (held) return;
        await open(url);
      },
    });
    try {
      expect(
        await new WoltlabDriver().login(session, origin, {
          username: "member",
          password: "secret-value",
        }),
      ).toBe(true);
      expect(held).toBe(false);
    } finally {
      await new Promise((doneClose, reject) =>
        server.close((error) => (error ? reject(error) : doneClose())),
      );
    }
  });

  it("treats the user menu as a signed-in homepage", async () => {
    const home = `<!DOCTYPE html><html><body>
<a class="userMenuItemLink" href="/account-management/">Konto</a>
<a class="userMenuItemLink" href="/settings/">Einstellungen</a>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(home);
    });
    const origin = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/`);
      });
    });
    const session = new HtmlBrowserSession();
    const driver = new WoltlabDriver();
    try {
      await session.goto(origin);
      expect(await driver.isLoggedIn(session)).toBe(true);
      expect(
        await driver.login(session, origin, { username: "member", password: "secret-value" }),
      ).toBe(true);
    } finally {
      await new Promise((doneClose, reject) =>
        server.close((error) => (error ? reject(error) : doneClose())),
      );
    }
  });

  it("lists topic links and opens the reply form", async () => {
    const index = `<!DOCTYPE html><html><body>
<a class="wbbBoardNode__lastPostLink wbbTopicLink" href="/forum/thread/9-old/?action=firstNew">Old</a>
<a class="wbbTopicLink" href="/forum/thread/4-diabetes-typ-2/">Diabetes Typ 2</a>
</body></html>`;
    const thread = `<!DOCTYPE html><html><body>
<a href="/forum/thread/4-diabetes-typ-2/?action=add">Antworten</a>
</body></html>`;
    const reply = `<!DOCTYPE html><html><body>
<form method="post" action="/forum/thread/4-diabetes-typ-2/?action=add">
<textarea id="text" name="text"></textarea>
<div class="formSubmit"><input type="submit" value="Absenden"></div>
</form>
</body></html>`;
    const posted = `<!DOCTYPE html><html><body><p>ok</p></body></html>`;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.writeHead(
        request.method === "POST" ? 302 : 200,
        request.method === "POST"
          ? {
              location: "/forum/thread/4-diabetes-typ-2/?postID=42#post42",
              "content-type": "text/html",
            }
          : { "content-type": "text/html" },
      );
      if (request.method === "POST") {
        response.end(posted);
        return;
      }
      if (url.pathname.endsWith("/forum/")) response.end(index);
      else if (url.searchParams.get("action") === "add") response.end(reply);
      else response.end(thread);
    });
    const origin = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/`);
      });
    });
    const session = new HtmlBrowserSession();
    const driver = new WoltlabDriver();
    try {
      const threads = await driver.listThreads(session, origin);
      expect(threads.map((threadRow) => threadRow.title)).toEqual(["Diabetes Typ 2"]);
      expect(threads[0]?.url).not.toContain("action=firstNew");
      expect(await driver.openReply(session, threads[0]!)).toBe(true);
      await driver.fillReply(session, "Kurzer Hinweis ohne Link.");
      const result = await driver.submitReply(session);
      expect(result.kind).toBe("posted");
      if (result.kind === "posted") expect(result.permalink).toContain("postID=42");
    } finally {
      await new Promise((doneClose, reject) =>
        server.close((error) => (error ? reject(error) : doneClose())),
      );
    }
  });

  it("records a quick reply when the board inserts the post without a redirect", async () => {
    const thread = `<!DOCTYPE html><html><body>
<a href="/forum/thread/1972-der-filme-thread/?postID=10#post10">10</a>
<form method="post" action="/forum/thread/1972-der-filme-thread/">
<textarea id="text" name="text" class="wysiwygTextarea"></textarea>
<button type="button" data-type="save">Absenden</button>
</form>
</body></html>`;
    const posted = `<!DOCTYPE html><html><body>
<a href="/forum/thread/1972-der-filme-thread/?postID=10#post10">10</a>
<a href="/forum/thread/1972-der-filme-thread/?postID=77#post77">77</a>
</body></html>`;
    const server = createServer(async (request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(request.method === "POST" ? posted : thread);
    });
    const origin = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/`);
      });
    });
    const session = new HtmlBrowserSession();
    const driver = new WoltlabDriver();
    try {
      expect(
        await driver.openReply(session, {
          url: `${origin}forum/thread/1972-der-filme-thread/`,
          title: "Filme",
        }),
      ).toBe(true);
      await driver.fillReply(session, "Kurzer Hinweis ohne Link.");
      const result = await driver.submitReply(session);
      expect(result).toEqual({
        kind: "posted",
        permalink: `${origin}forum/thread/1972-der-filme-thread/?postID=77#post77`,
      });
    } finally {
      await new Promise((doneClose, reject) =>
        server.close((error) => (error ? reject(error) : doneClose())),
      );
    }
  });
});

describe("woltlab permalinks", () => {
  it("keeps a hash permalink and a newly inserted post id", () => {
    expect(
      woltlabPermalink("https://www.med2-forum.de/forum/thread/1972-der-filme-thread/#post77"),
    ).toBe("https://www.med2-forum.de/forum/thread/1972-der-filme-thread/?postID=77#post77");
    expect(newestWoltlabPostId([10], [10, 77])).toBe(77);
    expect(newestWoltlabPostId([10], [10])).toBeNull();
    expect(
      woltlabPermalinkForPost("https://www.med2-forum.de/forum/thread/1972-der-filme-thread/", 77),
    ).toBe("https://www.med2-forum.de/forum/thread/1972-der-filme-thread/?postID=77#post77");
  });
});

platformSuite({
  driver: new WoltlabDriver(),
  start: startWoltlabFixture,
  door: "widget",
  widgetType: "turnstile",
  permalink: /\/forum\/thread\/1-membership\/\?postID=\d+#post\d+$/,
});
