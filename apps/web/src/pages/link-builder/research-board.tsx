import type { LbHostView, LbThreadView } from "@rakazo/contracts";
import { localDateKey } from "@rakazo/linkbuilder-core";
import { useState } from "react";
import { BuiButton, BuiCard } from "../../components/beautiful-ui/primitives";

type Lane = "scouting" | "picked" | "working" | "done" | "skipped";
const LANES: { id: Lane; label: string; color: string }[] = [
  { id: "scouting", label: "Scouting", color: "#7EB6FF" },
  { id: "picked", label: "Picked", color: "#FFE14A" },
  { id: "working", label: "In progress", color: "#E6C07B" },
  { id: "done", label: "Completed", color: "#8FDBA2" },
  { id: "skipped", label: "Skipped", color: "#E26D6D" },
];
interface Target {
  id: string;
  name: string;
  domain: string;
  url: string;
  kind: "Site" | "Page";
  lane: Lane;
  status: string;
  reason: string;
  tags: string[];
  score: number;
}
function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function hostLane(status: LbHostView["status"]): Lane {
  if (["discovered", "probed"].includes(status)) return "scouting";
  if (["qualified", "ready"].includes(status)) return "picked";
  if (["registering", "pending_email", "pending_admin", "warming"].includes(status))
    return "working";
  return status === "used" ? "done" : "skipped";
}
function activeUrl(current: string | null, candidate: string): boolean {
  const currentUrl = current && safeUrl(current);
  const candidateUrl = safeUrl(candidate);
  return Boolean(currentUrl && candidateUrl && currentUrl === candidateUrl);
}

export function ResearchBoard({
  hosts,
  threads,
  searches,
  currentUrl,
  dailyLimit,
  timeZone = "UTC",
}: {
  hosts: LbHostView[];
  threads: LbThreadView[];
  searches: number;
  currentUrl: string | null;
  dailyLimit?: number;
  timeZone?: string;
}) {
  const reviewedToday = hosts.filter(
    (host) =>
      host.lastProbeAt &&
      localDateKey(new Date(host.lastProbeAt), timeZone) === localDateKey(new Date(), timeZone),
  ).length;
  const [filter, setFilter] = useState<Lane | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("status");
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const targets: Target[] = [
    ...hosts.map(
      (host): Target => ({
        id: `site:${host.id}`,
        name: host.registrableDomain,
        domain: host.registrableDomain,
        url: host.homepageUrl,
        kind: "Site",
        lane: hostLane(host.status),
        status: host.status.replaceAll("_", " "),
        reason: host.statusReason || "No decision reason recorded yet.",
        tags: host.topicTags ?? [],
        score: host.qualityScore ?? 0,
      }),
    ),
    ...threads.map(
      (thread): Target => ({
        id: `page:${thread.id}`,
        name: thread.title || thread.domain,
        domain: thread.domain,
        url: thread.url,
        kind: "Page",
        lane:
          hostById.has(thread.hostId) && hostLane(hostById.get(thread.hostId)!.status) === "skipped"
            ? "skipped"
            : thread.status === "posted"
              ? "done"
              : thread.status === "rejected"
                ? "skipped"
                : activeUrl(currentUrl, thread.url)
                  ? "working"
                  : thread.status === "selected"
                    ? "picked"
                    : "scouting",
        status: thread.status,
        reason: thread.rejectReason || thread.excerpt || "No decision reason recorded yet.",
        tags: thread.openQuestion ? ["Open question"] : [],
        score: thread.relevance ?? 0,
      }),
    ),
  ];
  const shown = targets
    .filter(
      (target) =>
        (filter === "all" || target.lane === filter) &&
        `${target.name} ${target.domain} ${target.reason} ${target.tags.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "score"
        ? b.score - a.score
        : LANES.findIndex((lane) => lane.id === a.lane) -
          LANES.findIndex((lane) => lane.id === b.lane),
    );
  const evidence =
    searches > 0
      ? `${searches} searches recorded today`
      : targets.length
        ? "Saved research results"
        : "No research results recorded yet";
  return (
    <section aria-label="Research mission board" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium text-[#E8E4D8]">Research missions</h2>
          <p className="mt-1 text-xs text-[#A39E90]">
            {evidence} · {hosts.length} sites · {threads.length} pages
          </p>
        </div>
        <span className="font-mono text-xs text-[#8FDBA2]">
          {targets.filter((target) => target.lane === "done").length} completed
        </span>
      </div>
      {dailyLimit ? (
        <div className="flex flex-col gap-1 text-xs text-[#A39E90]">
          <span>
            {reviewedToday} reviewed today · daily cap {dailyLimit} sites
          </span>
          <progress
            aria-label="Daily research progress"
            max={dailyLimit}
            value={Math.min(reviewedToday, dailyLimit)}
            className="h-2 w-full accent-[#FFE14A]"
          />
        </div>
      ) : null}
      <fieldset className="flex flex-wrap gap-2" aria-label="Filter research stage">
        <BuiButton onClick={() => setFilter("all")} aria-pressed={filter === "all"}>
          All {targets.length}
        </BuiButton>
        {LANES.map((lane) => (
          <BuiButton
            key={lane.id}
            onClick={() => setFilter(lane.id)}
            aria-pressed={filter === lane.id}
          >
            <span aria-hidden style={{ color: lane.color }}>
              ◆
            </span>{" "}
            {lane.label} {targets.filter((target) => target.lane === lane.id).length}
          </BuiButton>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Find a research page"
          placeholder="Find a page or topic…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 border border-[#3A382F] bg-[#14130F] px-3 py-2 text-sm text-[#E8E4D8]"
        />
        <select
          aria-label="Sort research pages"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
          className="border border-[#3A382F] bg-[#14130F] px-2 py-2 text-sm text-[#E8E4D8]"
        >
          <option value="status">By stage</option>
          <option value="score">By score</option>
        </select>
      </div>
      <p role="status" className="text-xs text-[#A39E90]">
        {shown.length} targets shown
      </p>
      {targets.length === 0 ? (
        <BuiCard className="p-5 text-sm text-[#A39E90]">
          No pages saved yet. Discovered sites and pages will appear here after research returns
          results.
        </BuiCard>
      ) : shown.length === 0 ? (
        <p className="py-4 text-sm text-[#A39E90]">No targets match this filter.</p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
          {shown.map((target) => (
            <BuiCard key={target.id} className="min-w-0 overflow-hidden">
              <details className="group">
                <summary className="cursor-pointer list-none p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFE14A]">
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span style={{ color: LANES.find((lane) => lane.id === target.lane)?.color }}>
                      {LANES.find((lane) => lane.id === target.lane)?.label}
                    </span>
                    <span className="text-[#A39E90]">
                      {target.kind} · score{" "}
                      {Number.isFinite(target.score) ? target.score.toFixed(2) : "—"}
                    </span>
                  </div>
                  <h3 className="mt-2 break-words text-sm font-medium text-[#E8E4D8]">
                    {target.name}
                  </h3>
                  <p className="mt-1 truncate text-xs text-[#A39E90]">{target.domain}</p>
                  <span className="mt-3 block text-xs text-[#FFE14A]">
                    Inspect mission <span aria-hidden>↗</span>
                  </span>
                </summary>
                <div className="border-t border-[#3A382F] p-3 text-sm text-[#C8C4B8]">
                  <p className="capitalize">Recorded status: {target.status}</p>
                  <p className="mt-2 break-words">{target.reason}</p>
                  {target.tags.length ? (
                    <p className="mt-2 text-xs text-[#8FDBA2]">{target.tags.join(" · ")}</p>
                  ) : null}
                  {safeUrl(target.url) ? (
                    <a
                      href={safeUrl(target.url)!}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-block text-[#7EB6FF] underline"
                    >
                      Visit {target.kind.toLowerCase()} ↗
                    </a>
                  ) : null}
                </div>
              </details>
            </BuiCard>
          ))}
        </div>
      )}
    </section>
  );
}
