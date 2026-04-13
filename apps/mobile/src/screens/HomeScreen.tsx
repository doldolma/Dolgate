import React, { useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  getHostSearchText,
  getHostSubtitle,
} from "@dolssh/shared-core";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import { formatRelativeTime } from "../lib/mobile";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

export function HomeScreen(): React.JSX.Element {
  const palette = useMobilePalette();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [query, setQuery] = useState("");
  const auth = useMobileAppStore((state) => state.auth);
  const hosts = useMobileAppStore((state) => state.hosts);
  const sessions = useMobileAppStore((state) => state.sessions);
  const syncStatus = useMobileAppStore((state) => state.syncStatus);
  const connectToHost = useMobileAppStore((state) => state.connectToHost);
  const syncNow = useMobileAppStore((state) => state.syncNow);
  const isSyncing = syncStatus.status === "syncing";

  const recentActivityByHostId = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      if (!map.has(session.hostId)) {
        map.set(session.hostId, session.lastEventAt);
      }
    }
    return map;
  }, [sessions]);

  const filteredHosts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const nextHosts = normalizedQuery
      ? hosts.filter((host) =>
          getHostSearchText(host)
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery),
        )
      : hosts;

    return [...nextHosts].sort((left, right) => {
      const leftRecent = recentActivityByHostId.get(left.id) ?? "";
      const rightRecent = recentActivityByHostId.get(right.id) ?? "";
      if (leftRecent && rightRecent && leftRecent !== rightRecent) {
        return rightRecent.localeCompare(leftRecent);
      }
      if (leftRecent && !rightRecent) {
        return -1;
      }
      if (!leftRecent && rightRecent) {
        return 1;
      }
      return left.label.localeCompare(right.label);
    });
  }, [hosts, query, recentActivityByHostId]);

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: palette.background,
        },
      ]}
    >
      <View
        style={[
          styles.heroCard,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
          },
        ]}
      >
        <Text style={[styles.eyebrow, { color: palette.accent }]}>HOME</Text>
        <Text style={[styles.title, { color: palette.text }]}>
          SSH 호스트를 빠르게 다시 여는 모바일 홈입니다.
        </Text>
        <Text style={[styles.subtitle, { color: palette.mutedText }]}>
          동기화된 SSH 연결만 표시합니다. 최근 세션이 있으면 우선 정렬됩니다.
        </Text>
        {auth.status === "offline-authenticated" ? (
          <View
            style={[
              styles.banner,
              {
                backgroundColor: palette.accentSoft,
              },
            ]}
          >
            <Text style={[styles.bannerText, { color: palette.accent }]}>
              오프라인 캐시를 사용 중입니다. 네트워크가 복구되면 다시 동기화하세요.
            </Text>
          </View>
        ) : null}
        <View style={styles.heroActions}>
          <Pressable
            disabled={isSyncing}
            onPress={() => void syncNow()}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
                opacity: isSyncing ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[styles.secondaryButtonText, { color: palette.text }]}>
              {isSyncing ? "동기화 중" : "지금 동기화"}
            </Text>
          </Pressable>
        </View>
      </View>

      <View
        style={[
          styles.statusCard,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
          },
        ]}
      >
        <Text style={[styles.statusTitle, { color: palette.text }]}>
          Sync 상태
        </Text>
        <Text style={[styles.statusBody, { color: palette.mutedText }]}>
          {syncStatus.status}
          {syncStatus.pendingPush ? " • pending push" : ""}
          {syncStatus.lastSuccessfulSyncAt
            ? ` • ${formatRelativeTime(syncStatus.lastSuccessfulSyncAt)}`
            : ""}
        </Text>
        {syncStatus.errorMessage ? (
          <Text style={[styles.statusError, { color: palette.danger }]}>
            {syncStatus.errorMessage}
          </Text>
        ) : null}
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="호스트 검색"
        placeholderTextColor={palette.mutedText}
        style={[
          styles.searchInput,
          {
            color: palette.text,
            borderColor: palette.border,
            backgroundColor: palette.input,
          },
        ]}
      />

      <FlatList
        data={filteredHosts}
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
              표시할 SSH 호스트가 없습니다.
            </Text>
            <Text style={[styles.emptyBody, { color: palette.mutedText }]}>
              동기화된 SSH 호스트가 아직 없습니다. 서버 연결 상태를 확인한 뒤 다시 동기화하세요.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const recentActivity = recentActivityByHostId.get(item.id);

          return (
            <Pressable
              onPress={async () => {
                const sessionId = await connectToHost(item.id);
                if (sessionId) {
                  navigation.navigate("Session", { sessionId });
                }
              }}
              style={[
                styles.hostCard,
                {
                  backgroundColor: palette.surface,
                  borderColor: palette.border,
                },
              ]}
            >
              <View style={styles.hostRow}>
                <Text style={[styles.hostTitle, { color: palette.text }]}>
                  {item.label}
                </Text>
                <View
                  style={[
                    styles.badge,
                    {
                      backgroundColor: palette.accentSoft,
                    },
                  ]}
                >
                  <Text style={[styles.badgeText, { color: palette.accent }]}>
                    SSH
                  </Text>
                </View>
              </View>
              <Text style={[styles.hostSubtitle, { color: palette.mutedText }]}>
                {getHostSubtitle(item)}
              </Text>
              <Text style={[styles.hostMeta, { color: palette.mutedText }]}>
                {recentActivity
                  ? `최근 접속 ${formatRelativeTime(recentActivity)}`
                  : "아직 열린 세션 없음"}
              </Text>
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
    paddingTop: 16,
  },
  heroCard: {
    borderWidth: 1,
    borderRadius: 24,
    padding: 18,
    gap: 8,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.1,
  },
  title: {
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 30,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  banner: {
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 4,
  },
  bannerText: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  heroActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  primaryButton: {
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: "#04111A",
    fontSize: 15,
    fontWeight: "900",
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: "800",
  },
  statusCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    marginTop: 14,
  },
  statusTitle: {
    fontSize: 14,
    fontWeight: "800",
  },
  statusBody: {
    marginTop: 4,
    fontSize: 13,
  },
  statusError: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 14,
    fontSize: 15,
  },
  listContent: {
    paddingTop: 14,
    paddingBottom: 28,
    gap: 12,
  },
  hostCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 6,
  },
  hostRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  hostTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: "800",
  },
  hostSubtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  hostMeta: {
    fontSize: 12,
    fontWeight: "700",
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "800",
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    marginTop: 8,
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
