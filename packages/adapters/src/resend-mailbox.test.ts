import { describe, expect, it } from "vitest";
import { ResendMailbox } from "./resend-mailbox.js";

describe("ResendMailbox", () => {
  it("pages the receiving list and keeps mail for the requested recipient", async () => {
    const pages = [
      {
        has_more: true,
        data: [
          {
            id: "new-mail",
            to: ["other.person@sideinbox.email"],
            created_at: "2026-10-20T08:00:00.000Z",
          },
        ],
      },
      {
        has_more: false,
        data: [
          {
            id: "old-mail",
            to: ["Lena.Hoffmann@sideinbox.email"],
            created_at: "2026-10-16T08:00:00.000Z",
          },
        ],
      },
    ];
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/emails/receiving/old-mail")) {
        return new Response(
          JSON.stringify({
            from: "noreply@forum.example",
            subject: "Noch ein Schritt zur Aktivierung",
            text: "https://forum.example/activate",
            created_at: "2026-10-16T08:00:00.000Z",
          }),
          { status: 200 },
        );
      }
      const page = pages.shift();
      return new Response(JSON.stringify(page), { status: 200 });
    }) as typeof fetch;
    const mailbox = new ResendMailbox({
      domain: "sideinbox.email",
      apiKey: "re_test",
      prisma: { lbInboundMail: { findMany: async () => [] } } as never,
      fetch: fetchImpl,
    });
    const mail = await mailbox.listMessages("lena.hoffmann@sideinbox.email", {
      since: new Date("2026-10-15T00:00:00.000Z"),
    });
    expect(mail.map((row) => row.subject)).toEqual(["Noch ein Schritt zur Aktivierung"]);
    expect(urls.some((url) => url.includes("after=new-mail"))).toBe(true);
    expect(urls.some((url) => url.includes("limit=100"))).toBe(true);
  });
});
