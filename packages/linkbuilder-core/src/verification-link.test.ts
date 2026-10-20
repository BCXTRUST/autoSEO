import { describe, expect, it } from "vitest";
import { extractVerificationLink, mailMentionsOrigin } from "./verification-link.js";

const origin = "http://board.example.test:8080";

describe("verification link", () => {
  it("finds the phpBB activation link in a text mail", () => {
    const mail = {
      subject: "Welcome to Board",
      textBody: `Please visit ${origin}/ucp.php?mode=activate&u=42&k=ABC123. Thanks!`,
    };
    expect(extractVerificationLink(mail, origin)).toBe(
      `${origin}/ucp.php?mode=activate&u=42&k=ABC123`,
    );
  });

  it("decodes entities in HTML links", () => {
    const mail = {
      subject: "Activate",
      textBody: "",
      htmlBody: `<a href="${origin}/ucp.php?mode=activate&amp;u=7&amp;k=Z">activate</a>`,
    };
    expect(extractVerificationLink(mail, origin)).toBe(`${origin}/ucp.php?mode=activate&u=7&k=Z`);
  });

  it("ignores links on other origins, userinfo links and non-activation links", () => {
    const mail = {
      subject: "Activate",
      textBody: [
        "https://tracker.example.test/click?mode=activate",
        `http://user:pw@board.example.test:8080/ucp.php?mode=activate&k=1`,
        `${origin}/index.php`,
      ].join("\n"),
    };
    expect(extractVerificationLink(mail, origin)).toBeNull();
  });

  it("recognises German activation wording", () => {
    const mail = { subject: "Konto", textBody: `${origin}/konto/aktivieren?code=9` };
    expect(extractVerificationLink(mail, origin)).toBe(`${origin}/konto/aktivieren?code=9`);
  });

  it("follows a confirmation on a subdomain and skips a password reset", () => {
    const origin = "https://amsel.de/";
    expect(
      extractVerificationLink(
        {
          subject: "AMSEL Multiple Sklerose Forum",
          textBody: "https://www.amsel.de/multiple-sklerose-forum/confirm/abc",
        },
        origin,
      ),
    ).toBe("https://www.amsel.de/multiple-sklerose-forum/confirm/abc");
    expect(
      extractVerificationLink(
        {
          subject: "Kennwort vergessen",
          textBody: "https://www.med2-forum.de/lost-password/?k=1",
        },
        "https://www.med2-forum.de/",
      ),
    ).toBeNull();
  });

  it("tells whether a mail references the board", () => {
    expect(mailMentionsOrigin({ subject: "", textBody: `see ${origin}/x` }, origin)).toBe(true);
    expect(
      mailMentionsOrigin({ subject: "", textBody: "https://other.example.test" }, origin),
    ).toBe(false);
  });
});
