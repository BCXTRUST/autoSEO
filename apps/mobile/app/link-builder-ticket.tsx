import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import {
  artifactImageUri,
  type MobileLbArtifact,
  type MobileLbTicket,
  ticketActionBody,
  ticketCountdown,
} from "../lib/link-builder";

export default function LinkBuilderTicket() {
  const params = useLocalSearchParams<{
    projectId?: string;
    ticketId?: string;
    statusOnly?: string;
  }>();
  const projectId = String(params.projectId ?? "");
  const [tickets, setTickets] = useState<MobileLbTicket[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const next = await rpc<MobileLbTicket[]>("linkBuilder/operator/tickets", {
      projectId,
      status: "open",
    });
    setTickets(next.filter((ticket) => ticket.reason !== "captcha_unsolved"));
    setLoaded(true);
    if (params.statusOnly === "1") {
      const status = await rpc<{ activityLabel: string; run: { status: string } | null }>(
        "linkBuilder/projects/status",
        { projectId },
      );
      setStatusLine(`${status.activityLabel} · ${status.run?.status ?? "no run"}`);
    }
  }, [params.statusOnly, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const ticket = tickets.find((item) => item.id === params.ticketId) ?? tickets[0] ?? null;
  const shotId = ticket && !ticket.screenUrl ? ticket.screenshotArtifactId : null;
  const [shotUri, setShotUri] = useState<string | null>(null);

  useEffect(() => {
    setShotUri(null);
    if (!shotId) return;
    let live = true;
    rpc<MobileLbArtifact>("linkBuilder/artifacts/get", { projectId, artifactId: shotId })
      .then((artifact) => {
        if (live) setShotUri(artifactImageUri(artifact));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, shotId]);
  const screenUri = ticket?.screenUrl ?? shotUri;

  async function settle(kind: "continue" | "skip") {
    if (!ticket) return;
    setBusy(true);
    try {
      const path =
        kind === "continue" ? "linkBuilder/operator/continue" : "linkBuilder/operator/skip";
      await rpc(path, { projectId, ticketId: ticket.id, ...ticketActionBody(note) });
      setDone(kind === "continue" ? "Continued" : "Skipped");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!loaded && !ticket && !statusLine) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#ECECEE" />
      </View>
    );
  }
  if (!ticket) {
    return <View style={styles.screen} />;
  }

  return (
    <View style={styles.screen}>
      {statusLine ? <Text style={styles.domain}>{statusLine}</Text> : null}
      {ticket ? (
        <>
          <Text style={styles.domain}>{ticket.domain}</Text>
          {ticketCountdown(ticket.expiresAt) ? (
            <Text accessibilityLabel="Ticket countdown" style={styles.muted}>
              {ticketCountdown(ticket.expiresAt)}
            </Text>
          ) : null}
          <View style={styles.screenBox} accessibilityLabel="Live screen">
            {screenUri ? (
              <Image
                source={{ uri: screenUri }}
                style={styles.shot}
                accessibilityLabel="Screenshot"
              />
            ) : (
              <Text style={styles.muted}>Live screen</Text>
            )}
          </View>
          <TextInput
            accessibilityLabel="Note"
            value={note}
            onChangeText={setNote}
            placeholder="Note"
            placeholderTextColor="#85858A"
            style={styles.note}
          />
          {done ? <Text style={styles.done}>{done}</Text> : null}
          <Pressable
            accessibilityLabel="I've solved it, continue"
            disabled={busy}
            onPress={() => void settle("continue")}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>I've solved it, continue</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Skip host"
            disabled={busy}
            onPress={() => void settle("skip")}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Skip host</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  screen: { flex: 1, backgroundColor: "#000", padding: 16, gap: 12 },
  domain: { color: "#ECECEE", fontSize: 20 },
  screenBox: {
    minHeight: 220,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#2A2A31",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  shot: { width: "100%", height: 220 },
  muted: { color: "#85858A" },
  note: {
    color: "#ECECEE",
    borderWidth: 1,
    borderColor: "#2A2A31",
    borderRadius: 12,
    padding: 12,
  },
  done: { color: "#3dbb72" },
  primary: { backgroundColor: "#7785ff", borderRadius: 999, padding: 14, alignItems: "center" },
  primaryText: { color: "#090a12", fontWeight: "600" },
  secondary: { borderRadius: 999, padding: 14, alignItems: "center", backgroundColor: "#232327" },
  secondaryText: { color: "#ECECEE" },
});
