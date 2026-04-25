import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  buildVisibleGroups,
  collectGroupPaths,
  getGroupLabel,
  getHostSearchText,
  getHostSubtitle,
  type HostRecord,
  isDirectHostChild,
  normalizeGroupPath,
  type GroupCardView,
} from "@dolssh/shared-core";
import {
  useFocusEffect,
  useNavigation,
  useScrollToTop,
} from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import Ionicons from "react-native-vector-icons/Ionicons";
import { IosEdgeSwipeBack } from "../components/IosEdgeSwipeBack";
import { formatRelativeTime } from "../lib/mobile";
import type { MainTabParamList } from "../navigation/RootNavigator";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

type HomeListItem =
  | {
      kind: "group";
      group: GroupCardView;
    }
  | {
      kind: "host";
      host: HostRecord;
      showGroupMeta: boolean;
    };

export function HomeScreen(): React.JSX.Element {
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding();
  const navigation = useNavigation<NavigationProp<MainTabParamList>>();
  const listRef = useRef<FlatList<HomeListItem> | null>(null);
  const searchInputRef = useRef<TextInput | null>(null);
  const scrollToTopRef = useRef<{ scrollToTop: () => void }>({
    scrollToTop: () => undefined,
  });
  const [query, setQuery] = useState("");
  const [currentGroupPath, setCurrentGroupPath] = useState<string | null>(null);
  const [groupHistory, setGroupHistory] = useState<Array<string | null>>([]);
  const auth = useMobileAppStore((state) => state.auth);
  const groups = useMobileAppStore((state) => state.groups);
  const hosts = useMobileAppStore((state) => state.hosts);
  const sessions = useMobileAppStore((state) => state.sessions);
  const syncStatus = useMobileAppStore((state) => state.syncStatus);
  const connectToHost = useMobileAppStore((state) => state.connectToHost);
  const isSearching = query.trim().length > 0;
  useScrollToTop(scrollToTopRef);

  const recentActivityByHostId = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      if (!map.has(session.hostId)) {
        map.set(session.hostId, session.lastEventAt);
      }
    }
    return map;
  }, [sessions]);

  const groupNameByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) {
      const normalizedPath = normalizeGroupPath(group.path);
      if (!normalizedPath) {
        continue;
      }
      map.set(normalizedPath, group.name?.trim() || getGroupLabel(normalizedPath));
    }
    return map;
  }, [groups]);

  const availableGroupPaths = useMemo(
    () => collectGroupPaths(groups, hosts),
    [groups, hosts],
  );
  const availableGroupPathSet = useMemo(
    () => new Set(availableGroupPaths),
    [availableGroupPaths],
  );

  useEffect(() => {
    const sanitizedHistory = groupHistory.filter(
      (path) => path === null || availableGroupPathSet.has(path),
    );
    if (
      sanitizedHistory.length !== groupHistory.length ||
      sanitizedHistory.some((path, index) => path !== groupHistory[index])
    ) {
      setGroupHistory(sanitizedHistory);
    }

    if (currentGroupPath && !availableGroupPathSet.has(currentGroupPath)) {
      const nextGroupPath = sanitizedHistory.at(-1) ?? null;
      setCurrentGroupPath(nextGroupPath);
      setGroupHistory(sanitizedHistory.slice(0, -1));
    }
  }, [availableGroupPathSet, currentGroupPath, groupHistory]);

  const scrollHomeListToTop = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
  }, []);

  const resetHomeView = useCallback(() => {
    searchInputRef.current?.blur();
    setQuery("");
    setCurrentGroupPath(null);
    setGroupHistory([]);
    scrollHomeListToTop();
  }, [scrollHomeListToTop]);

  scrollToTopRef.current.scrollToTop = resetHomeView;

  const openGroup = useCallback(
    (groupPath: string) => {
      setGroupHistory((previous) => [...previous, currentGroupPath]);
      setCurrentGroupPath(groupPath);
      scrollHomeListToTop();
    },
    [currentGroupPath, scrollHomeListToTop],
  );

  const goBackInHome = useCallback(() => {
    if (query.trim().length > 0) {
      searchInputRef.current?.blur();
      setQuery("");
      return true;
    }

    const previousGroupPath = groupHistory.at(-1);
    if (previousGroupPath === undefined) {
      return false;
    }

    setGroupHistory((previous) => previous.slice(0, -1));
    setCurrentGroupPath(previousGroupPath);
    scrollHomeListToTop();
    return true;
  }, [groupHistory, query, scrollHomeListToTop]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => goBackInHome(),
      );
      return () => {
        subscription.remove();
      };
    }, [goBackInHome]),
  );

  const sortHosts = (nextHosts: HostRecord[]) =>
    [...nextHosts].sort((left, right) => {
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

  const visibleGroups = useMemo(() => {
    if (isSearching) {
      return [];
    }
    return buildVisibleGroups(groups, hosts, currentGroupPath);
  }, [currentGroupPath, groups, hosts, isSearching]);

  const filteredHosts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const nextHosts = isSearching
      ? hosts.filter((host) =>
          getHostSearchText(host)
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery),
        )
      : hosts.filter((host) =>
          isDirectHostChild(host.groupName ?? null, currentGroupPath),
        );

    return sortHosts(nextHosts);
  }, [currentGroupPath, hosts, isSearching, query, recentActivityByHostId]);

  const listData = useMemo<HomeListItem[]>(() => {
    if (isSearching) {
      return filteredHosts.map((host) => ({
        kind: "host",
        host,
        showGroupMeta: true,
      }));
    }

    return [
      ...visibleGroups.map((group) => ({
        kind: "group" as const,
        group,
      })),
      ...filteredHosts.map((host) => ({
        kind: "host" as const,
        host,
        showGroupMeta: false,
      })),
    ];
  }, [filteredHosts, isSearching, visibleGroups]);

  const currentGroupTitle = currentGroupPath
    ? groupNameByPath.get(currentGroupPath) ?? getGroupLabel(currentGroupPath)
    : "All Hosts";
  const currentGroupSubtitle = currentGroupPath
    ? currentGroupPath
    : `${visibleGroups.length}개 폴더`;

  const emptyState = useMemo(() => {
    if (isSearching) {
      return {
        title: "검색 결과가 없습니다.",
        body: "다른 이름이나 주소로 다시 검색해보세요.",
      };
    }
    if (currentGroupPath) {
      return {
        title: "이 그룹에는 직접 속한 호스트가 없습니다.",
        body: "하위 폴더를 열거나 다른 그룹으로 이동해보세요.",
      };
    }
    return {
      title: "아직 호스트가 없습니다.",
      body: "여기에 접속 가능한 호스트 목록이 표시됩니다.",
    };
  }, [currentGroupPath, isSearching]);

  const statusBanner = useMemo(() => {
    if (auth.status === "offline-authenticated") {
      return {
        title: "오프라인 캐시를 사용 중입니다.",
        body:
          syncStatus.errorMessage ??
          "네트워크가 복구되면 최신 상태로 다시 확인합니다.",
        borderColor: palette.warning,
      };
    }

    if (syncStatus.status === "error" && syncStatus.errorMessage) {
      return {
        title: "최신 상태를 아직 확인하지 못했습니다.",
        body: syncStatus.errorMessage,
        borderColor: palette.danger,
      };
    }

    return null;
  }, [auth.status, palette.danger, palette.warning, syncStatus]);

  const getSearchGroupMeta = (host: HostRecord): string | null => {
    const groupPath = normalizeGroupPath(host.groupName);
    if (!groupPath) {
      return null;
    }

    if (groupNameByPath.has(groupPath)) {
      return groupPath;
    }
    return groupPath;
  };

  const getCompactHostMeta = (host: HostRecord): string => {
    const subtitle = getHostSubtitle(host);
    const recentActivity = recentActivityByHostId.get(host.id);
    const activityLabel = recentActivity
      ? `최근 사용 ${formatRelativeTime(recentActivity)}`
      : "세션 없음";
    return `${subtitle} • ${activityLabel}`;
  };

  const getHomeHostBadgeLabel = (host: HostRecord): string => {
    switch (host.kind) {
      case "aws-ec2":
        return "AWS SSM";
      case "aws-ecs":
        return "ECS";
      case "warpgate-ssh":
        return "WARP";
      case "serial":
        return "SER";
      default:
        return "SSH";
    }
  };

  return (
    <IosEdgeSwipeBack onBack={() => void goBackInHome()}>
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
          ref={searchInputRef}
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

        {statusBanner ? (
          <View
            style={[
              styles.statusCard,
              {
                backgroundColor: palette.surface,
                borderColor: statusBanner.borderColor,
              },
            ]}
          >
            <Text style={[styles.statusTitle, { color: palette.text }]}>
              {statusBanner.title}
            </Text>
            <Text style={[styles.statusBody, { color: palette.mutedText }]}>
              {statusBanner.body}
            </Text>
          </View>
        ) : null}

        {!isSearching ? (
          <View style={styles.groupHeader}>
            {groupHistory.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="이전 그룹으로 이동"
                onPress={() => void goBackInHome()}
                style={[
                  styles.groupBackButton,
                  {
                    borderColor: palette.border,
                    backgroundColor: palette.surface,
                  },
                ]}
              >
                <Ionicons name="chevron-back" size={18} color={palette.text} />
              </Pressable>
            ) : null}
            <View style={styles.groupHeaderCopy}>
              <Text style={[styles.groupTitle, { color: palette.text }]}>
                {currentGroupTitle}
              </Text>
              <Text
                style={[styles.groupSubtitle, { color: palette.mutedText }]}
              >
                {currentGroupSubtitle}
              </Text>
            </View>
          </View>
        ) : null}

        <FlatList
          ref={listRef}
          style={styles.list}
          data={listData}
          keyExtractor={(item) =>
            item.kind === "group"
              ? `group:${item.group.path}`
              : `host:${item.host.id}`
          }
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
                {emptyState.title}
              </Text>
              <Text style={[styles.emptyBody, { color: palette.mutedText }]}>
                {emptyState.body}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            if (item.kind === "group") {
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.group.name} 그룹 열기`}
                  onPress={() => {
                    openGroup(item.group.path);
                  }}
                  style={[
                    styles.groupCard,
                    {
                      backgroundColor: palette.surface,
                      borderColor: palette.border,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.groupIcon,
                      {
                        backgroundColor: palette.accentSoft,
                      },
                    ]}
                  >
                    <Ionicons
                      name="folder-open-outline"
                      size={18}
                      color={palette.accent}
                    />
                  </View>
                  <View style={styles.groupCardCopy}>
                    <Text
                      style={[styles.groupCardTitle, { color: palette.text }]}
                    >
                      {item.group.name}
                    </Text>
                    <Text
                      style={[
                        styles.groupCardMeta,
                        { color: palette.mutedText },
                      ]}
                    >
                      {item.group.hostCount}개 호스트
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={palette.mutedText}
                  />
                </Pressable>
              );
            }

            const searchGroupMeta = item.showGroupMeta
              ? getSearchGroupMeta(item.host)
              : null;
            const compactMeta = getCompactHostMeta(item.host);

            return (
              <Pressable
                onPress={async () => {
                  const sessionId = await connectToHost(item.host.id);
                  if (sessionId) {
                    navigation.navigate("Sessions");
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
                  <Text
                    numberOfLines={1}
                    style={[styles.hostTitle, { color: palette.text }]}
                  >
                    {item.host.label}
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
                      {getHomeHostBadgeLabel(item.host)}
                    </Text>
                  </View>
                </View>
                {searchGroupMeta ? (
                  <Text
                    numberOfLines={1}
                    style={[styles.hostGroupMeta, { color: palette.mutedText }]}
                  >
                    그룹 {searchGroupMeta}
                  </Text>
                ) : null}
                <Text
                  numberOfLines={1}
                  style={[styles.hostMeta, { color: palette.mutedText }]}
                >
                  {compactMeta}
                </Text>
              </Pressable>
            );
          }}
        />
      </View>
    </IosEdgeSwipeBack>
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
  statusCard: {
    marginTop: 14,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  statusTitle: {
    fontSize: 13,
    fontWeight: "700",
  },
  statusBody: {
    fontSize: 12,
    lineHeight: 17,
  },
  groupHeader: {
    marginTop: 14,
    marginBottom: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  groupBackButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  groupHeaderCopy: {
    flex: 1,
    gap: 2,
  },
  groupTitle: {
    fontSize: 17,
    fontWeight: "800",
  },
  groupSubtitle: {
    fontSize: 12,
  },
  list: {
    flex: 1,
    marginTop: 12,
  },
  listContent: {
    gap: 12,
  },
  groupCard: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  groupIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  groupCardCopy: {
    flex: 1,
    gap: 4,
  },
  groupCardTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  groupCardMeta: {
    fontSize: 13,
  },
  hostCard: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 5,
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  hostTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
  },
  hostGroupMeta: {
    fontSize: 11,
    lineHeight: 15,
  },
  hostMeta: {
    fontSize: 11,
    lineHeight: 15,
  },
  badge: {
    borderRadius: 999,
    minWidth: 40,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.2,
    flexShrink: 0,
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
