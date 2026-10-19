import { describe, expect, it } from "vitest";
import {
  boardLink,
  chosenLink,
  pageLookPrompt,
  sameSiteUrl,
  threadsFromLinks,
  usablePageLinks,
} from "./link-builder-page-move.js";

const page = "https://www.office-fragen.de/";
const domain = "office-fragen.de";

describe("page move when rules find no thread", () => {
  it("keeps a same-site board and drops logout", () => {
    expect(sameSiteUrl("/board/12-excel/", page, domain)).toBe(
      "https://www.office-fragen.de/board/12-excel/",
    );
    expect(sameSiteUrl("https://evil.example/board/1", page, domain)).toBeNull();
    expect(sameSiteUrl("/ucp.php?mode=logout", page, domain)).toBeNull();
  });

  it("reads thread links the rules missed, and opens a matching board", () => {
    const links = usablePageLinks(
      [
        { text: "Abmelden", href: "/ucp.php?mode=logout" },
        { text: "Portal", href: "/portal" },
        { text: "Excel", href: "/board/12-excel/" },
        { text: "Welche Formel?", href: "/thread/88-welche-formel/" },
      ],
      page,
      domain,
    );
    expect(threadsFromLinks(links).map((thread) => thread.title)).toEqual(["Welche Formel?"]);
    expect(boardLink(links, ["excel", "office"])?.text).toBe("Excel");
  });

  it("reads the thread and board links this forum actually uses", () => {
    const links = usablePageLinks(
      [
        { text: "Portal", href: "/" },
        { text: "Excel", href: "forum-2.html" },
        {
          text: "Falsche Darstellung von Datum und Uhrzeit",
          href: "thread-29336-lastpost.html",
        },
      ],
      page,
      domain,
    );
    expect(threadsFromLinks(links).map((thread) => thread.url)).toEqual([
      "https://www.office-fragen.de/thread-29336-lastpost.html",
    ]);
    expect(
      threadsFromLinks([
        {
          text: "Serie",
          url: "https://www.med2-forum.de/forum/thread/328-serienjunkies/?action=firstNew",
        },
      ]).map((thread) => thread.url),
    ).toEqual(["https://www.med2-forum.de/forum/thread/328-serienjunkies/"]);
    expect(boardLink(links, ["excel"])?.url).toBe("https://www.office-fragen.de/forum-2.html");
  });

  it("accepts only an index from the list shown to the model", () => {
    const links = usablePageLinks([{ text: "Excel", href: "/board/12-excel/" }], page, domain);
    expect(chosenLink(links, "open", 0)?.url).toContain("/board/12-excel/");
    expect(chosenLink(links, "open", 4)).toBeNull();
    expect(chosenLink(links, "skip", 0)).toBeNull();
    expect(pageLookPrompt(links)).toContain("0. Excel");
    expect(pageLookPrompt(links)).not.toContain("https://evil.example");
  });
});
