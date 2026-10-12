import { useEffect, useState } from "react";
import "./beautiful-ui.css";

/* Beautiful UI primitives — hand-ported from beautifului.dev
   (github.com/TurboKach/ai-native-react-components, MIT © 2026 Turbo).
   The upstream components are demo showcases; these ports keep their visual
   and motion language (pixel-grid loader, shimmer sweep, pop-in success) and
   expose real props. */

/** A light sweep travelling across a text label. */
export function Shimmer({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="bg-clip-text text-transparent"
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--bui-ink-3) 35%, var(--bui-ink) 50%, var(--bui-ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: "bui-shimmer-text 1.4s linear infinite",
      }}
    >
      {children}
    </span>
  );
}

// Chevron wavefront: each 3×3 cell fires by column distance from the center row.
const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const column = i % 3;
  return (column + Math.abs(row - 1)) * 90;
});

function useElapsed(resetKey: string): string {
  const [deciseconds, setDeciseconds] = useState(0);
  useEffect(() => {
    setDeciseconds(0);
    const timer = setInterval(() => setDeciseconds((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [resetKey]);
  const total = deciseconds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/** Pixel-grid loader with shimmering label and live elapsed timer. */
export function LoadingState({
  label = "working",
  prominent = false,
}: {
  label?: string;
  /** Larger type for the computer pane, where this is the whole screen. */
  prominent?: boolean;
}) {
  const elapsed = useElapsed(label);
  const cell = prominent ? "h-[5px] w-[5px]" : "h-[4px] w-[4px]";
  return (
    <span className={`flex w-fit items-center ${prominent ? "gap-3.5" : "gap-2.5"}`}>
      <span aria-hidden className={`grid grid-cols-3 ${prominent ? "gap-[2px]" : "gap-[1.5px]"}`}>
        {CHEVRON_DELAYS.map((delay, i) => (
          <span
            key={i}
            className={`${cell} rounded-[1px]`}
            style={{
              background: "var(--bui-ink)",
              opacity: 0.15,
              animation: `bui-pixel-on 650ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </span>
      <span
        className={prominent ? "text-[22px] font-medium leading-none" : "text-[13.5px] font-medium"}
      >
        <Shimmer>{label}</Shimmer>
      </span>
      <span
        className={`font-mono tabular-nums ${prominent ? "text-[14px]" : "text-[12px]"}`}
        style={{ color: "var(--bui-ink-3)" }}
      >
        {elapsed}
      </span>
    </span>
  );
}

/** Pop-in green check with a fading-up label — the approval-card success beat. */
export function SuccessPop({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full text-white"
        style={{
          background: "var(--bui-green)",
          animation: "bui-pop-in 300ms cubic-bezier(0.23,1,0.32,1) both",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      <span
        className="text-[13px] font-medium"
        style={{
          color: "var(--bui-ink)",
          animation: "bui-fade-up 350ms cubic-bezier(0.23,1,0.32,1) 100ms both",
        }}
      >
        {label}
      </span>
    </span>
  );
}

/** Card shell with Beautiful UI's surface + layered shadow treatment. */
export function BuiCard({
  children,
  className = "",
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={`rounded-[16px] ${className}`}
      style={{ background: "var(--bui-surface)", boxShadow: "var(--bui-shadow-card)", ...style }}
    >
      {children}
    </div>
  );
}

function TaskMark({ status }: { status: "working" | "done" | "blocked" }) {
  if (status === "working") {
    const size = 22;
    const stroke = 2;
    const radius = (size - stroke) / 2;
    const turn = 2 * Math.PI * radius;
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <svg
          width={size}
          height={size}
          className="absolute inset-0"
          style={{ animation: "bui-spin 1.1s linear infinite", transformOrigin: "center" }}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--bui-line)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--bui-ink-3)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${turn * 0.28} ${turn * 0.72}`}
          />
        </svg>
      </span>
    );
  }
  const blocked = status === "blocked";
  return (
    <span
      className="flex h-5 w-5 items-center justify-center rounded-full text-white"
      style={{
        background: blocked ? "#e5484d" : "var(--bui-green)",
        animation: "bui-pop-in 300ms cubic-bezier(0.23,1,0.32,1) both",
      }}
      aria-hidden
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={blocked ? "M18 6 6 18M6 6l12 12" : "M20 6 9 17l-5-5"} />
      </svg>
    </span>
  );
}

/** Task list row. Working rows shimmer; finished rows keep a check or a block mark. */
export function TaskRow({
  status,
  label,
  meta,
}: {
  status: "working" | "done" | "blocked";
  label: string;
  meta?: string;
}) {
  return (
    <div
      className="flex h-11 items-center gap-2.5 border-b border-[var(--bui-line)] px-2.5 last:border-b-0"
      data-status={status}
      style={{ animation: "bui-fade-up 450ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <TaskMark status={status} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--bui-ink)]">
        {status === "working" ? <Shimmer>{label}</Shimmer> : label}
      </span>
      {meta ? (
        <span className="font-mono text-[11.5px] tabular-nums text-[var(--bui-ink-3)]">{meta}</span>
      ) : null}
    </div>
  );
}

/** Primary pill button in the Beautiful UI control style. */
export function BuiButton({
  children,
  onClick,
  disabled,
  tone = "neutral",
  label,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "neutral" | "accent";
  /** Accessible name when the visible label is not enough on its own. */
  label?: string;
}) {
  const accent = tone === "accent";
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative inline-flex items-center gap-1.5 border-2 border-[#3A382F] px-3 py-1.5 text-[13px] font-medium shadow-[3px_3px_0_#2A2820] disabled:opacity-50 ${
        accent ? "bg-[#FFE14A] text-[#1A1608]" : "bg-[#1C1B16] text-[#E8E4D8]"
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute -right-px -top-px h-2.5 w-2.5 ${
          accent ? "bg-[#0E0D0A]" : "bg-[#FFE14A]"
        }`}
        style={{ clipPath: "polygon(100% 0, 0 0, 100% 100%)" }}
      />
      {children}
    </button>
  );
}
