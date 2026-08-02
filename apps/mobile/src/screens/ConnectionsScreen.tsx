import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import Ionicons from "react-native-vector-icons/Ionicons";
import { formatRelativeTime } from "../lib/mobile";
import type { MainTabParamList } from "../navigation/RootNavigator";
import { useScreenPadding } from "../lib/screen-layout";
import {
  sortSessionsByRecency,
  useMobileAppStore,
} from "../store/useMobileAppStore";
import { type MobilePalette, useMobilePalette } from "../theme";

function getStatusTone(status: string, palette: MobilePalette) {
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

function canRemoveSession(status: string) {
  return (
    status !== "connected" &&
    status !== "connecting" &&
    status !== "disconnecting"
  );
}

export function ConnectionsScreen(): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const screenPadding = useScreenPadding();
  const navigation = useNavigation<NavigationProp<MainTabParamList>>();
  const storedSessions = useMobileAppStore((state) => state.sessions);
  const hosts = useMobileAppStore((state) => state.hosts);
  const resumeSession = useMobileAppStore((state) => state.resumeSession);
  const removeSession = useMobileAppStore((state) => state.removeSession);

  // 스토어의 sessions 는 터미널 탭 순서(추가된 순서)다. 이 목록은 "현재/최근
  // 세션"이라 최근순이 맞으므로 여기서 정렬한다 — 탭 순서를 최근순으로 두면
  // 출력이 올 때마다 탭이 재배치돼 타이핑 중에 튄다.
  const sessions = useMemo(
    () => sortSessionsByRecency(storedSessions),
    [storedSessions],
  );

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
          paddingHorizontal: screenPadding.paddingHorizontal,
          paddingTop: screenPadding.paddingTop,
        },
      ]}
    >
      <Text style={[styles.title, { color: palette.text }]}>Connections</Text>
      <Text style={[styles.subtitle, { color: palette.mutedText }]}>
        {translate("connections.title")}
      </Text>

      <FlatList
        style={styles.list}
        data={sessions}
        keyExtractor={(item) => item.id}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
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
              {translate("connections.emptyTitle")}
            </Text>
            <Text style={[styles.emptyBody, { color: palette.mutedText }]}>
              {translate("connections.emptyBody")}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const tone = getStatusTone(item.status, palette);
          const removable = canRemoveSession(item.status);
          const openSession = async () => {
            const sessionId = await resumeSession(item.id);
            if (sessionId) {
              navigation.navigate("Sessions");
            }
          };

          return (
            <View
              style={[
                styles.sessionCard,
                {
                  backgroundColor: palette.surface,
                  borderColor: palette.border,
                },
              ]}
            >
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={translate("connections.openAria", { title: item.title })}
                  onPress={openSession}
                  style={styles.rowOpenArea}
                >
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
                </Pressable>
                <View style={styles.rowActions}>
                  {removable ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={translate("connections.deleteAria", { title: item.title })}
                      hitSlop={10}
                      onPress={() => {
                        void removeSession(item.id);
                      }}
                      style={[
                        styles.removeButton,
                        {
                          backgroundColor: palette.surfaceAlt,
                          borderColor: palette.border,
                        },
                      ]}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={16}
                        color={palette.danger}
                      />
                    </Pressable>
                  ) : null}
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={translate("connections.openBodyAria", { title: item.title })}
                onPress={async () => {
                  await openSession();
                }}
                style={styles.cardBody}
              >
                <Text style={[styles.meta, { color: palette.mutedText }]}>
                  {hostLabelById.get(item.hostId) ?? translate("connections.deletedHost")} •{" "}
                  {formatRelativeTime(item.lastEventAt)}
                </Text>
                <Text style={[styles.meta, { color: palette.mutedText }]}>
                  {item.hasReceivedOutput
                    ? translate("connections.hasSnapshot")
                    : translate("connections.noSnapshot")}
                  {item.isRestorable ? translate("connections.restorable") : ""}
                </Text>
                {item.errorMessage ? (
                  <Text style={[styles.errorText, { color: palette.danger }]}>
                    {item.errorMessage}
                  </Text>
                ) : item.connectionStatusMessage ? (
                  <Text style={[styles.meta, { color: palette.mutedText }]}>
                    {item.connectionStatusMessage}
                  </Text>
                ) : null}
              </Pressable>
            </View>
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
  title: {
    fontSize: 28,
    fontWeight: "900",
  },
  subtitle: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 20,
  },
  list: {
    flex: 1,
    marginTop: 16,
  },
  listContent: {
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
  rowOpenArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
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
  removeButton: {
    width: 34,
    height: 34,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cardBody: {
    gap: 8,
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
