import type {
  AgentToolExecutionResult,
  ComputerAction,
  ComputerObservation,
} from "@rakazo/adapter-kit";
import { looksLikeCaptchaWall } from "@rakazo/core";

export function parseComputerActions(value: unknown): ComputerAction[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("computer_act requires at least one action");
  }
  if (value.length > 24) throw new Error("computer_act accepts at most 24 actions");
  const actions = value.flatMap((raw): ComputerAction[] => {
    if (!raw || typeof raw !== "object") throw new Error("computer action must be an object");
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "");
    if (kind === "click" || kind === "move" || kind === "down" || kind === "up") {
      const x = finiteCoordinate(action.x, "x");
      const y = finiteCoordinate(action.y, "y");
      const pointer: ComputerAction = {
        kind: "pointer",
        x,
        y,
        type: kind,
        button: action.button === "right" ? "right" : "left",
      };
      return action.double === true && kind === "click" ? [pointer, pointer] : [pointer];
    }
    if (kind === "type") {
      return [{ kind: "clipboard", text: String(action.text ?? "") }];
    }
    if (kind === "key") {
      return [
        {
          kind: "key",
          key: String(action.key ?? ""),
          modifiers: Array.isArray(action.modifiers) ? action.modifiers.map(String) : undefined,
        },
      ];
    }
    if (kind === "scroll") {
      return [
        {
          kind: "scroll",
          direction: action.direction === "up" ? "up" : "down",
          amount: boundedNumber(action.amount, 1, 20, 3),
        },
      ];
    }
    if (kind === "wait") {
      return [{ kind: "wait", ms: boundedNumber(action.ms, 0, 5_000, 350) }];
    }
    throw new Error(`unsupported computer action ${kind || "(missing)"}`);
  });
  if (actions.length > 24) {
    throw new Error("computer_act expands to more than 24 actions; split the batch");
  }
  return actions;
}

export const MAX_OBSERVE_WITHOUT_ACT = 2;
export const OBSERVE_WITHOUT_ACT_ERROR =
  "Screen already captured. Call computer_act or open_path now; do not observe again until the screen should have changed.";

export function shouldRefuseObserve(observeWithoutAct: number): boolean {
  return observeWithoutAct >= MAX_OBSERVE_WITHOUT_ACT;
}

export function shouldAttachObservationToThread(input: {
  unchanged: boolean;
  source: "observe" | "act";
  attachedObserveInStreak: boolean;
}): boolean {
  if (input.unchanged) return false;
  if (input.source === "observe" && input.attachedObserveInStreak) return false;
  return true;
}

export function observationWallText(observation: ComputerObservation): string {
  return [
    observation.activeWindow?.title,
    ...(observation.windows ?? []).map((window) => window.title),
  ]
    .filter(Boolean)
    .join("\n");
}

export function observationToolResult(
  observation: ComputerObservation,
  note = "computer observed",
  previousFrameId?: string,
): AgentToolExecutionResult {
  const details = {
    frameId: observation.frameId,
    capturedAt: observation.capturedAt,
    width: observation.width,
    height: observation.height,
    cursor: observation.cursor,
    activeWindow: observation.activeWindow,
    windows: observation.windows,
  };
  const unchanged = previousFrameId === observation.frameId;
  const windowLine = observation.windows?.length
    ? `\nOpen windows: ${observation.windows
        .map((window) => `${window.title || window.id}${window.focused ? " (focused)" : ""}`)
        .join("; ")}`
    : "";
  const wallText = observationWallText(observation);
  const captchaLine = looksLikeCaptchaWall(wallText)
    ? "\nCAPTCHA or bot-check is on screen. Do not wait there. Leave with open_path to a non-Google http(s) URL for the user's request. request_takeover only if the destination site is blocked."
    : "";
  return {
    kind: "agent_tool_result",
    content: [
      {
        type: "text",
        text: `${note}${unchanged ? " (screen unchanged)" : ""}${windowLine}${captchaLine}\n${JSON.stringify(details)}`,
      },
      ...(unchanged
        ? []
        : [
            {
              type: "image" as const,
              data: Buffer.from(observation.image).toString("base64"),
              mimeType: observation.mimeType,
            },
          ]),
    ],
    details,
  };
}

export function observationScreenshot(
  result: AgentToolExecutionResult,
): { bytes: Uint8Array; mimeType: string; name: string } | undefined {
  const image = result.content.find((part) => part.type === "image");
  if (image?.type !== "image" || !image.data) return undefined;
  const mimeType = image.mimeType || "image/png";
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  return {
    bytes: Uint8Array.from(Buffer.from(image.data, "base64")),
    mimeType,
    name: `computer-screen.${ext}`,
  };
}

function finiteCoordinate(value: unknown, name: string) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0 || number > 100_000) {
    throw new Error(`computer action ${name} must be a non-negative coordinate`);
  }
  return number;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}
