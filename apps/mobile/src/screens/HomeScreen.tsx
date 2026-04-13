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
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

export function HomeScreen(): React.JSX.Element {
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [query, setQuery] = useState("");
  const hosts = useMobileAppStore((state) => state.hosts);
  const sessions = useMobileAppStore((state) => state.sessions);
  const connectToHost = useMobileAppStore((state) => state.connectToHost);

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
          paddingHorizontal: screenPadding.paddingHorizontal,
          paddingTop: screenPadding.paddingTop,
        },
      ]}
    >
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
        style={styles.list}
        data={filteredHosts}
        keyExtractor={(item) => item.id}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        removeClippedSubviews
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: screenPadding.paddingBottom },
        ]}
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
              아직 SSH 호스트가 없습니다.
            </Text>
            <Text style={[styles.emptyBody, { color: palette.mutedText }]}>
              여기에 접속 가능한 호스트 목록이 표시됩니다.
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
                  ? `최근 사용 ${formatRelativeTime(recentActivity)}`
                  : "세션 없음"}
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
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 15,
  },
  list: {
    flex: 1,
    marginTop: 14,
  },
  listContent: {
    gap: 12,
  },
  hostCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 8,
  },
  hostRow: {
    flexDirection: "row",
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
    lineHeight: 18,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.2,
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
