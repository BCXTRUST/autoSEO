import { useCallback, useEffect, useRef, useState } from "react";
import { CampaignRequestGate } from "./campaign-request";
import type {
  CampaignActivity,
  CampaignChallengeResult,
  CampaignChallengeStatus,
  CampaignConfig,
  CampaignItem,
  CampaignMode,
  CampaignPublicationAction,
  CampaignPublicationStatus,
  CampaignRecord,
  CampaignStateSnapshot,
} from "./campaign-types";
import { rpc } from "./rpc";

const POLL_MS = 4_000;
const REQUEST_TIMEOUT_MS = 12_000;
const nonce = () => crypto.randomUUID();

function request<T>(
  work: (signal: AbortSignal) => Promise<T>,
  routeSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onRouteAbort = () => controller.abort();
  if (routeSignal?.aborted) controller.abort();
  else routeSignal?.addEventListener("abort", onRouteAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  return work(controller.signal)
    .catch((cause) => {
      if (timedOut) throw new Error("Request timed out");
      throw cause;
    })
    .finally(() => {
      clearTimeout(timer);
      routeSignal?.removeEventListener("abort", onRouteAbort);
    });
}

function mergeById<T extends { id: string }>(oldValues: T[], newValues: T[]) {
  const map = new Map(oldValues.map((value) => [value.id, value]));
  for (const value of newValues) map.set(value.id, value);
  return [...map.values()];
}
function mergeActivities(oldValues: CampaignActivity[], newValues: CampaignActivity[]) {
  const map = new Map(oldValues.map((value) => [value.sequence, value]));
  for (const value of newValues) map.set(value.sequence, value);
  return [...map.values()].sort((a, b) => a.sequence - b.sequence);
}

export function mergeCampaignSnapshots(
  previous: CampaignStateSnapshot | null,
  next: CampaignStateSnapshot,
): CampaignStateSnapshot {
  if (!previous) return next;
  return {
    ...next,
    items: mergeById(previous.items, next.items),
    jobs: mergeById(previous.jobs, next.jobs),
    activities: mergeActivities(previous.activities, next.activities),
  };
}

export function useCampaignList() {
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pendingNonces = useRef(new Map<string, string>());
  const refresh = useCallback(async () => {
    try {
      const result = await request((signal) => rpc.campaigns.list(undefined, { signal }));
      setCampaigns(result as CampaignRecord[]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const create = useCallback(async (config: CampaignConfig, mode: CampaignMode) => {
    const key = JSON.stringify([config, mode]);
    const clientNonce = pendingNonces.current.get(key) ?? nonce();
    pendingNonces.current.set(key, clientNonce);
    const result = await request((signal) =>
      rpc.campaigns.create({ config, mode, clientNonce }, { signal }),
    );
    pendingNonces.current.delete(key);
    setCampaigns((current) => [result as CampaignRecord, ...current]);
    return result as CampaignRecord;
  }, []);
  const stopAll = useCallback(async () => {
    const key = "stop-all";
    const clientNonce = pendingNonces.current.get(key) ?? nonce();
    pendingNonces.current.set(key, clientNonce);
    const result = await request((signal) => rpc.campaigns.stopAll({ clientNonce }, { signal }));
    pendingNonces.current.delete(key);
    await refresh();
    return result;
  }, [refresh]);
  return { campaigns, loading, error, refresh, create, stopAll };
}

export function useCampaignDetail(campaignId: string) {
  const [snapshot, setSnapshot] = useState<CampaignStateSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [challengeStatus, setChallengeStatus] = useState<CampaignChallengeStatus | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [publicationStatus, setPublicationStatus] = useState<CampaignPublicationStatus | null>(
    null,
  );
  const [publicationError, setPublicationError] = useState<string | null>(null);
  const [publicationActions, setPublicationActions] = useState<CampaignPublicationAction[]>([]);
  const [publicationActionsError, setPublicationActionsError] = useState<string | null>(null);
  const publicationSerial = useRef(0);
  const mounted = useRef(false);
  const serial = useRef(0);
  const requestGate = useRef(new CampaignRequestGate());
  const routeSignal = useRef<AbortSignal | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const cursor = useRef<number | null>(null);
  const pendingNonces = useRef(new Map<string, string>());
  const getNonce = useCallback((key: string) => {
    const current = pendingNonces.current.get(key) ?? nonce();
    pendingNonces.current.set(key, current);
    return current;
  }, []);

  const fetchSnapshot = useCallback(
    (afterSequence: number, append = false) => {
      const currentSignal = routeSignal.current;
      if (!currentSignal) return Promise.resolve();
      return requestGate.current.run(campaignId, currentSignal, async (signal) => {
        const requestSerial = ++serial.current;
        try {
          const [snapshotResult, challengeResult, publicationActionsResult] =
            await Promise.allSettled([
              request(
                (requestSignal) =>
                  rpc.campaigns.get({ campaignId, afterSequence }, { signal: requestSignal }),
                signal,
              ),
              request(
                (requestSignal) =>
                  rpc.campaigns.challengeStatus({ campaignId }, { signal: requestSignal }),
                signal,
              ),
              request(
                (requestSignal) =>
                  rpc.campaigns.publicationActions({ campaignId }, { signal: requestSignal }),
                signal,
              ),
            ]);
          if (snapshotResult.status === "rejected") throw snapshotResult.reason;
          const result = snapshotResult.value as CampaignStateSnapshot;
          if (!mounted.current || requestSerial !== serial.current) return;
          cursor.current = result.nextCursor;
          setSnapshot((current) => (append ? mergeCampaignSnapshots(current, result) : result));
          setStale(false);
          setError(null);
          if (challengeResult.status === "fulfilled") {
            setChallengeStatus(challengeResult.value as CampaignChallengeStatus);
            setChallengeError(null);
          } else {
            setChallengeError(
              challengeResult.reason instanceof Error
                ? challengeResult.reason.message
                : "Status unavailable",
            );
          }
          if (publicationActionsResult.status === "fulfilled") {
            setPublicationActions(publicationActionsResult.value as CampaignPublicationAction[]);
            setPublicationActionsError(null);
          } else {
            setPublicationActionsError(
              publicationActionsResult.reason instanceof Error
                ? publicationActionsResult.reason.message
                : "Publication ledger unavailable",
            );
          }
        } catch (cause) {
          if (!mounted.current || requestSerial !== serial.current || signal.aborted) return;
          setStale(true);
          setError(cause instanceof Error ? cause.message : "Connection interrupted");
        } finally {
          if (mounted.current && requestSerial === serial.current) setLoading(false);
        }
      });
    },
    [campaignId],
  );

  const refresh = useCallback(async () => {
    const last = snapshotRef.current?.activities.at(-1)?.sequence ?? 0;
    await fetchSnapshot(last, Boolean(snapshotRef.current));
  }, [fetchSnapshot]);

  const refreshPublicationStatus = useCallback(async () => {
    const signal = routeSignal.current;
    if (!signal) return;
    const requestSerial = ++publicationSerial.current;
    try {
      const result = (await request(
        (requestSignal) =>
          rpc.campaigns.publicationStatus({ campaignId }, { signal: requestSignal }),
        signal,
      )) as CampaignPublicationStatus;
      if (!mounted.current || signal.aborted || requestSerial !== publicationSerial.current) return;
      setPublicationStatus(result);
      setPublicationError(null);
    } catch (cause) {
      if (!mounted.current || signal.aborted || requestSerial !== publicationSerial.current) return;
      setPublicationError(
        cause instanceof Error ? cause.message : "Publication status unavailable",
      );
    }
  }, [campaignId]);

  const refreshPublicationActions = useCallback(async () => {
    const signal = routeSignal.current;
    if (!signal) return;
    try {
      const result = (await request(
        (requestSignal) =>
          rpc.campaigns.publicationActions({ campaignId }, { signal: requestSignal }),
        signal,
      )) as CampaignPublicationAction[];
      if (!mounted.current || signal.aborted) return;
      setPublicationActions(result);
      setPublicationActionsError(null);
    } catch (cause) {
      if (!mounted.current || signal.aborted) return;
      setPublicationActionsError(
        cause instanceof Error ? cause.message : "Publication ledger unavailable",
      );
    }
  }, [campaignId]);

  useEffect(() => {
    mounted.current = true;
    const signal = requestGate.current.activate(campaignId);
    routeSignal.current = signal;
    setSnapshot(null);
    snapshotRef.current = null;
    cursor.current = null;
    setLoading(true);
    setError(null);
    setStale(false);
    setChallengeStatus(null);
    setChallengeError(null);
    setPublicationStatus(null);
    setPublicationError(null);
    setPublicationActions([]);
    setPublicationActionsError(null);
    void fetchSnapshot(0);
    void refreshPublicationStatus();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        await fetchSnapshot(
          snapshotRef.current?.activities.at(-1)?.sequence ?? 0,
          Boolean(snapshotRef.current),
        );
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchSnapshot(
          snapshotRef.current?.activities.at(-1)?.sequence ?? 0,
          Boolean(snapshotRef.current),
        );
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      mounted.current = false;
      serial.current++;
      requestGate.current.deactivate(campaignId, signal);
      publicationSerial.current++;
      if (routeSignal.current === signal) routeSignal.current = null;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [campaignId, fetchSnapshot, refreshPublicationStatus]);

  const loadMore = useCallback(async () => {
    if (cursor.current === null || !snapshotRef.current?.hasMore) return;
    await fetchSnapshot(cursor.current, true);
  }, [fetchSnapshot]);
  const control = useCallback(
    async (action: "start" | "pause" | "resume") => {
      const key = `control:${action}`;
      await request(
        (signal) =>
          rpc.campaigns.control({ campaignId, action, clientNonce: getNonce(key) }, { signal }),
        routeSignal.current ?? undefined,
      );
      pendingNonces.current.delete(key);
      await Promise.all([
        fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true),
        refreshPublicationStatus(),
      ]);
    },
    [campaignId, fetchSnapshot, getNonce, refreshPublicationStatus],
  );
  const updateConfig = useCallback(
    async (config: CampaignConfig) => {
      const current = snapshotRef.current?.campaign;
      if (!current) throw new Error("Campaign is still loading");
      try {
        await request(
          (signal) =>
            rpc.campaigns.update(
              { campaignId, expectedRevision: current.revision, config },
              { signal },
            ),
          routeSignal.current ?? undefined,
        );
      } catch (cause) {
        await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
        throw cause;
      }
      await Promise.all([
        fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true),
        refreshPublicationStatus(),
      ]);
    },
    [campaignId, fetchSnapshot, refreshPublicationStatus],
  );
  const addItem = useCallback(
    async (input: { kind: "source" | "opportunity"; url: string; title: string }) => {
      const key = `add:${JSON.stringify(input)}`;
      await request(
        (signal) =>
          rpc.campaigns.addItem({ campaignId, ...input, clientNonce: getNonce(key) }, { signal }),
        routeSignal.current ?? undefined,
      );
      pendingNonces.current.delete(key);
      await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
    },
    [campaignId, fetchSnapshot, getNonce],
  );
  const recoverItem = useCallback(
    async (item: CampaignItem, action: "retry" | "defer" | "skip") => {
      const key = `recover:${item.id}:${action}`;
      try {
        await request(
          (signal) =>
            rpc.campaigns.recoverItem(
              {
                campaignId,
                itemId: item.id,
                action,
                clientNonce: getNonce(key),
              },
              { signal },
            ),
          routeSignal.current ?? undefined,
        );
      } catch (cause) {
        await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
        throw cause;
      }
      pendingNonces.current.delete(key);
      await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
    },
    [campaignId, fetchSnapshot, getNonce],
  );
  const reviewOpportunity = useCallback(
    async (item: CampaignItem, action: "select" | "dismiss") => {
      const key = `review-opportunity:${item.id}:${item.updatedAt}:${action}`;
      try {
        await request(
          (signal) =>
            rpc.campaigns.reviewOpportunity(
              {
                campaignId,
                itemId: item.id,
                expectedUpdatedAt: item.updatedAt,
                action,
                clientNonce: getNonce(key),
              },
              { signal },
            ),
          routeSignal.current ?? undefined,
        );
      } catch (cause) {
        await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
        throw cause;
      }
      pendingNonces.current.delete(key);
      await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
    },
    [campaignId, fetchSnapshot, getNonce],
  );
  const review = useCallback(
    async (item: CampaignItem, decision: "approve" | "reject") => {
      try {
        await request(
          (signal) =>
            rpc.campaigns.review(
              {
                campaignId,
                itemId: item.id,
                decision,
                expectedUpdatedAt: item.updatedAt,
              },
              { signal },
            ),
          routeSignal.current ?? undefined,
        );
      } catch (cause) {
        await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
        throw cause;
      }
      await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
    },
    [campaignId, fetchSnapshot],
  );
  const updateDraft = useCallback(
    async (item: CampaignItem, body: string) => {
      try {
        await request(
          (signal) =>
            rpc.campaigns.updateDraft(
              {
                campaignId,
                itemId: item.id,
                body,
                expectedUpdatedAt: item.updatedAt,
              },
              { signal },
            ),
          routeSignal.current ?? undefined,
        );
      } catch (cause) {
        await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
        throw cause;
      }
      await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
    },
    [campaignId, fetchSnapshot],
  );
  const challengeResult = useCallback(
    async (taskId: string) => {
      return (await request(
        (signal) => rpc.campaigns.challengeResult({ campaignId, taskId }, { signal }),
        routeSignal.current ?? undefined,
      )) as CampaignChallengeResult;
    },
    [campaignId],
  );
  const stopAll = useCallback(async () => {
    const key = "stop-all";
    const result = await request(
      (signal) => rpc.campaigns.stopAll({ clientNonce: getNonce(key) }, { signal }),
      routeSignal.current ?? undefined,
    );
    pendingNonces.current.delete(key);
    await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
    return result;
  }, [fetchSnapshot, getNonce]);
  const pollChallenge = useCallback(
    async (taskId: string) => {
      const result = await request(
        (signal) => rpc.campaigns.pollChallenge({ campaignId, taskId }, { signal }),
        routeSignal.current ?? undefined,
      );
      await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
      return result;
    },
    [campaignId, fetchSnapshot],
  );
  const publishDraft = useCallback(
    async (item: CampaignItem, topicId: number) => {
      const key = `publish:${item.id}:${item.updatedAt}:${topicId}`;
      try {
        const result = (await request(
          (signal) =>
            rpc.campaigns.publishDraft(
              {
                campaignId,
                draftId: item.id,
                expectedUpdatedAt: item.updatedAt,
                topicId,
                clientNonce: getNonce(key),
                confirmReviewed: true,
              },
              { signal },
            ),
          routeSignal.current ?? undefined,
        )) as CampaignPublicationAction;
        pendingNonces.current.delete(key);
        await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
        return result;
      } catch (cause) {
        await fetchSnapshot(snapshotRef.current?.activities.at(-1)?.sequence ?? 0, true);
        throw cause;
      }
    },
    [campaignId, fetchSnapshot, getNonce],
  );
  const verifyPublication = useCallback(
    async (actionId: string) => {
      try {
        const result = (await request(
          (signal) => rpc.campaigns.verifyPublication({ campaignId, actionId }, { signal }),
          routeSignal.current ?? undefined,
        )) as CampaignPublicationAction;
        await refreshPublicationActions();
        return result;
      } catch (cause) {
        await refreshPublicationActions();
        throw cause;
      }
    },
    [campaignId, refreshPublicationActions],
  );
  return {
    snapshot,
    stale,
    loading,
    error,
    challengeStatus,
    challengeError,
    publicationStatus,
    publicationError,
    publicationActions,
    publicationActionsError,
    refreshPublicationStatus,
    refreshPublicationActions,
    refresh,
    loadMore,
    control,
    stopAll,
    pollChallenge,
    updateConfig,
    addItem,
    recoverItem,
    reviewOpportunity,
    review,
    updateDraft,
    challengeResult,
    publishDraft,
    verifyPublication,
  };
}
