import React, { useMemo } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import { formatRelativeTime } from "../lib/mobile";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

function getStatusTone(status: string, palette: ReturnType<typeof useMobilePalette>) {
  switch (status) {
    case "connected":
      return { background: palette.accentSoft, text: palette.success };
    case "connecting":
    case "pending":
    case "disconnecting":
      return { background: palette.surfaceAlt, text: palette.warning };
    case "error":
      return { background: palette.surfaceAlt, text: palette.danger };
    default:
      return { background: palette.surfaceAlt, text: palette.mutedText };
  }
}

export function ConnectionsScreen(): React.JSX.Element {
  const palette = useMobilePalette();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const sessions = useMobileAppStore((state) => state.sessions);
  const hosts = useMobileAppStore((state) => state.hosts);
  const resumeSession = useMobileAppStore((state) => state.resumeSession);

  const hostLabelById = useMemo(
    () => new Map(hosts.map((host) => [host.id, host.label])),
    [hosts],
  );

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: palette.background,
        },
      ]}
    >
      <Text style={[styles.title, { color: palette.text }]}>Connections</Text>
      <Text style={[styles.subtitle, { color: palette.mutedText }]}>
        현재 세션과 최근 세션을 한 곳에서 이어서 사용할 수 있습니다.
      </Text>

      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View
            style={[
              styles.emptyCard,
              {
                backgroundColor: palette.surface,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.emptyTitle, { color: palette.text }]}>
              아직 세션이 없습니다.
            </Text>
            <Text style={[styles.emptyBody, { color: palette.mutedText }]}>
              Home에서 호스트를 열면 이 화면에 재사용 가능한 연결이 쌓입니다.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const tone = getStatusTone(item.status, palette);
          return (
            <Pressable
              onPress={async () => {
                const sessionId = await resumeSession(item.id);
                if (sessionId) {
                  navigation.navigate("Session", { sessionId });
                }
              }}
              style={[
                styles.sessionCard,
                {
                  backgroundColor: palette.surface,
                  borderColor: palette.border,
                },
              ]}
            >
              <View style={styles.row}>
                <Text style={[styles.sessionTitle, { color: palette.text }]}>
                  {item.title}
                </Text>
                <View
                  style={[
                    styles.statusBadge,
                    {
                      backgroundColor: tone.background,
                    },
                  ]}
                >
                  <Text style={[styles.statusBadgeText, { color: tone.text }]}>
                    {item.status}
                  </Text>
                </View>
              </View>
              <Text style={[styles.meta, { color: palette.mutedText }]}>
                {hostLabelById.get(item.hostId) ?? "삭제된 호스트"} •{" "}
                {formatRelativeTime(item.lastEventAt)}
              </Text>
              <Text style={[styles.meta, { color: palette.mutedText }]}>
                {item.hasReceivedOutput
                  ? "최근 출력 스냅샷 있음"
                  : "최근 출력 스냅샷 없음"}
                {item.isRestorable ? " • 다시 열기 가능" : ""}
              </Text>
              {item.errorMessage ? (
                <Text style={[styles.errorText, { color: palette.danger }]}>
                  {item.errorMessage}
                </Text>
              ) : null}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 18,
  },
  title: {
    fontSize: 28,
    fontWeight: "900",
  },
  subtitle: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 20,
  },
  listContent: {
    paddingTop: 18,
    paddingBottom: 28,
    gap: 12,
  },
  sessionCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 8,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  sessionTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: "800",
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  meta: {
    fontSize: 13,
    lineHeight: 18,
  },
  errorText: {
    fontSize: 13,
    fontWeight: "700",
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "800",
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
  },
});
