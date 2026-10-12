import { describe, expect, it } from "vitest";
import {
  artifactImageUri,
  linkBuilderPushRoute,
  OPERATOR_TICKET_PATH,
  projectStatusLine,
  ticketActionBody,
  ticketCountdown,
} from "./link-builder.js";

describe("mobile link builder", () => {
  it("summarizes counters and run state", () => {
    expect(
      projectStatusLine({
        activityLabel: "running",
        newToday: 1,
        newPerDay: 2,
        liveToday: 1,
        livePerDay: 2,
      }),
    ).toBe("running · NEW 1/2 · LIVE 1/2");
    expect(
      projectStatusLine({
        activityLabel: "needs operator ×10",
        newToday: 0,
        newPerDay: 2,
        liveToday: 0,
        livePerDay: 1,
        operatorHelp: { label: "Skip board.example" },
      }),
    ).toBe("Skip board.example · NEW 0/2 · LIVE 0/1");
  });

  it("sends a note only when the operator typed one", () => {
    expect(ticketActionBody("  solved  ")).toEqual({ note: "solved" });
    expect(ticketActionBody("   ")).toEqual({});
    expect(OPERATOR_TICKET_PATH).toBe("/link-builder-ticket");
    expect(
      linkBuilderPushRoute({
        url: "/link-builder-ticket?projectId=p1",
        projectId: "p1",
        ticketId: "t1",
      }),
    ).toEqual({ pathname: "/link-builder-ticket", params: { projectId: "p1", ticketId: "t1" } });
    expect(
      ticketCountdown("2026-10-05T17:00:00.000Z", Date.parse("2026-10-05T12:00:00.000Z")),
    ).toBe("5h 0m");
  });

  it("shows only raster screenshots", () => {
    expect(artifactImageUri({ mimeType: "image/png", contentBase64: "iVBO" })).toBe(
      "data:image/png;base64,iVBO",
    );
    expect(artifactImageUri({ mimeType: "text/html", contentBase64: "PGh0bWw+" })).toBeNull();
  });
});
