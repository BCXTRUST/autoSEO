import { describe, expect, it } from "vitest";
import { clickAccountActivation, clickResendMail } from "./registration-flow.js";

describe("clickResendMail", () => {
  it("clicks a mail resend control and ignores a generic send", async () => {
    const clicked: string[] = [];
    const session = {
      clickables: async () => [
        { selector: "#post", text: "Send" },
        { selector: "#again", text: "Aktivierungsmail erneut senden" },
      ],
      click: async (selector: string) => {
        clicked.push(selector);
      },
    };
    expect(await clickResendMail(session as never)).toBe(true);
    expect(clicked).toEqual(["#again"]);
  });

  it("leaves the page alone when there is no resend control", async () => {
    const session = {
      clickables: async () => [{ selector: "#post", text: "Beitrag senden" }],
      click: async () => {
        throw new Error("clicked");
      },
    };
    expect(await clickResendMail(session as never)).toBe(false);
  });
});

describe("clickAccountActivation", () => {
  it("clicks the Discourse activate button", async () => {
    const clicked: string[] = [];
    const session = {
      exists: async (selector: string) => selector === "#activate-account-button",
      waitFor: async () => true,
      click: async (selector: string) => {
        clicked.push(selector);
      },
    };
    expect(await clickAccountActivation(session as never)).toBe(true);
    expect(clicked).toEqual(["#activate-account-button"]);
  });
});
