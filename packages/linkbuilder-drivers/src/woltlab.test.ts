import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { platformSuite } from "./platform-suite.js";
import { HtmlBrowserSession } from "./testing/html-session.js";
import { startWoltlabFixture } from "./testing/woltlab-fixture.js";
import { WoltlabDriver } from "./woltlab.js";

describe("woltlab login", () => {
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
});

platformSuite({
  driver: new WoltlabDriver(),
  start: startWoltlabFixture,
  door: "widget",
  widgetType: "turnstile",
  permalink: /\/forum\/thread\/1-membership\/\?postID=\d+#post\d+$/,
});
