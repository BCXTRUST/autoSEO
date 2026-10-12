import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { type MobileLbCard, projectStatusLine } from "../lib/link-builder";

export default function LinkBuilderStatus() {
  const router = useRouter();
  const [cards, setCards] = useState<MobileLbCard[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await rpc<MobileLbCard[]>("linkBuilder/projects/list");
      setCards(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (loading && cards.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#ECECEE" />
      </View>
    );
  }

  return (
    <FlatList
      data={cards}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <Pressable
          accessibilityLabel={item.operatorHelp?.label ?? item.name}
          onPress={() => {
            const help = item.operatorHelp;
            if (help) {
              const path =
                help.action === "skip"
                  ? "linkBuilder/operator/skip"
                  : "linkBuilder/operator/continue";
              void rpc(path, { projectId: item.id, ticketId: help.ticketId }).then(() => load());
              return;
            }
            if (item.operatorQueue > 0) {
              router.push({ pathname: "/link-builder-ticket", params: { projectId: item.id } });
              return;
            }
            router.push({
              pathname: "/link-builder-ticket",
              params: { projectId: item.id, statusOnly: "1" },
            });
          }}
          style={styles.card}
        >
          <Text style={styles.name}>{item.name}</Text>
          <Text style={styles.line}>{projectStatusLine(item)}</Text>
          <Text style={styles.event}>{item.lastEvent ?? item.runStatus ?? "No events yet"}</Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 12, backgroundColor: "#000" },
  card: { backgroundColor: "#141416", borderRadius: 16, padding: 14, gap: 6 },
  name: { color: "#ECECEE", fontSize: 17 },
  line: { color: "#C9C9CE", fontSize: 14 },
  event: { color: "#85858A", fontSize: 13 },
});
