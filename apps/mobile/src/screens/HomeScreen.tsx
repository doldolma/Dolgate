import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  BackHandler,
  FlatList,
  Platform,
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
  formatQuickSshHostLabel,
  type GroupCardView,
  type GroupRemoveMode,
  parseQuickSshInput,
  type ParsedQuickSshCommand,
} from "@dolssh/shared-core";
import {
  useFocusEffect,
  useNavigation,
  useScrollToTop,
} from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import Ionicons from "react-native-vector-icons/Ionicons";
import type { SettingsSectionKey } from "../navigation/RootNavigator";
import { GroupActionSheet } from "../components/GroupActionSheet";
import { GroupNamePromptModal } from "../components/GroupNamePromptModal";
import { HostActionSheet } from "../components/HostActionSheet";
import { IosEdgeSwipeBack } from "../components/IosEdgeSwipeBack";
import { formatRelativeTime } from "../lib/mobile";
import type {
  MainTabParamList,
  RootStackParamList,
} from "../navigation/RootNavigator";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";
import { hostSubtitleLabels } from '../i18n/shared-messages';
import { useTranslation } from "react-i18next";

// 즐겨찾기는 데스크톱과 같이 최상단에 고정된 하나의 그룹으로 다룬다 — 누르면 일반 그룹처럼
// 호스트 목록으로 들어간다. 실제 그룹 경로와 겹칠 수 없는 값이어야 해서 NUL 을 앞에 붙인다
// (사용자가 만드는 그룹 이름에는 들어갈 수 없는 문자다).
const FAVORITES_GROUP_PATH = "\u0000favorites";

type HomeListItem =
  | {
      kind: "favorites";
      hostCount: number;
    }
  | {
      kind: "group";
      group: GroupCardView;
    }
  | {
      kind: "host";
      host: HostRecord;
      showGroupMeta: boolean;
    }
  | {
      /** 그룹 목록을 닫는 "새 그룹" 줄. 지금 보고 있는 경로의 하위로 만든다. */
      kind: "new-group";
    }
  | {
      /**
       * 검색 중에만 나오는 동작 항목. 데스크톱 명령 팔레트에서 **카드가 못 하는 것**만
       * 가져왔다 — 주소를 치면 즉석 접속, 섹션 이름을 치면 설정 직행.
       */
      kind: "action";
      action: HomeAction;
    };

type HomeAction =
  | { type: "quick-connect"; target: ParsedQuickSshCommand }
  | { type: "settings"; section: SettingsSectionKey };

const SETTINGS_SECTION_ALIASES: Record<SettingsSectionKey, string[]> = {
  account: ["account", "계정", "로그인"],
  server: ["server", "서버", "동기화", "sync"],
  security: ["security", "보안", "볼트", "vault"],
  app: ["app", "앱", "설정", "settings", "테마", "theme"],
};

function matchSettingsSections(query: string): SettingsSectionKey[] {
  const needle = query.trim().toLowerCase();
  // **앞부분 일치**다. 부분 일치로 두면 "nas" 를 치는 첫 글자 "n" 에서 account·server·app
  // 이 한꺼번에 걸려(각각 account·sync·settings 안의 n) 설정 줄 셋이 목록 맨 위로 튀었다가
  // 두 번째 글자에서 사라진다. 데스크톱은 점수로 밀어내지만 여기는 순서가 고정이라 못 밀어낸다.
  // 알파벳 한 글자도 같은 이유로 무시한다("s" → server·security·app). 한글 한 글자는
  // 담는 정보가 달라서(예: "앱") 남긴다.
  if (!needle || /^[a-z0-9]$/.test(needle)) {
    return [];
  }
  return (
    Object.keys(SETTINGS_SECTION_ALIASES) as SettingsSectionKey[]
  ).filter((section) =>
    SETTINGS_SECTION_ALIASES[section].some((alias) =>
      alias.toLowerCase().startsWith(needle),
    ),
  );
}

function actionKey(action: HomeAction): string {
  if (action.type === "settings") {
    return `action:settings:${action.section}`;
  }
  return "action:quick-connect";
}

export function HomeScreen(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding();
  const navigation =
    useNavigation<NavigationProp<MainTabParamList & RootStackParamList>>();
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
  const openSftpForHost = useMobileAppStore(
    (state) => state.openSftpForHost,
  );
  const deleteHost = useMobileAppStore((state) => state.deleteHost);
  const createGroup = useMobileAppStore((state) => state.createGroup);
  const renameGroup = useMobileAppStore((state) => state.renameGroup);
  const removeGroup = useMobileAppStore((state) => state.removeGroup);
  const quickConnectSsh = useMobileAppStore((state) => state.quickConnectSsh);
  const toggleHostFavorite = useMobileAppStore(
    (state) => state.toggleHostFavorite,
  );
  const [actionSheetGroup, setActionSheetGroup] = useState<GroupCardView | null>(
    null,
  );
  /** 이름 입력 모달. 새로 만들기와 이름 변경이 같은 모달을 쓴다. */
  const [groupPrompt, setGroupPrompt] = useState<
    { mode: "create" } | { mode: "rename"; group: GroupCardView } | null
  >(null);
  const [groupBusy, setGroupBusy] = useState(false);
  /** 시트가 닫히기를 기다리는 입력 모달(iOS). 위 onRename 주석 참고. */
  const [pendingGroupPrompt, setPendingGroupPrompt] = useState<
    { mode: "rename"; group: GroupCardView } | null
  >(null);
  const [actionSheetHost, setActionSheetHost] = useState<HostRecord | null>(
    null,
  );
  const isSearching = query.trim().length > 0;
  useScrollToTop(scrollToTopRef);

  const recentActivityByHostId = useMemo(() => {
    // 호스트별 "가장 최근" 활동. sessions 는 탭 순서(추가된 순서)라 최근순이
    // 아니므로, 첫 항목을 취하지 않고 더 큰 타임스탬프를 고른다.
    const map = new Map<string, string>();
    for (const session of sessions) {
      const known = map.get(session.hostId);
      if (!known || session.lastEventAt > known) {
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

  // 이 두 값은 정렬(sortHosts)에 의존하지 않으므로 앞에서 구한다 — 아래 경로 정리 로직이
  // 즐겨찾기 목적지를 모르면 화면을 되돌려 보낸다.
  const isFavoritesView = currentGroupPath === FAVORITES_GROUP_PATH;
  const hasFavorites = useMemo(
    () => hosts.some((host) => host.favorite === true),
    [hosts],
  );

  const availableGroupPaths = useMemo(
    () => collectGroupPaths(groups, hosts),
    [groups, hosts],
  );
  // 즐겨찾기 경로도 유효한 목적지로 넣는다 — 아래 정리 로직이 모르는 경로를 되돌려 보낸다.
  const availableGroupPathSet = useMemo(() => {
    const paths = new Set(availableGroupPaths);
    if (hasFavorites) {
      paths.add(FAVORITES_GROUP_PATH);
    }
    return paths;
  }, [availableGroupPaths, hasFavorites]);

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

  // **이름 오름차순 하나로 고정한다.** 예전에는 "활동이 있는 호스트 먼저(lastEventAt 내림차순)"
  // 를 앞에 뒀는데, lastEventAt 은 원격 출력마다 갱신된다. 그래서 세션이 출력을 뿜는 동안 그
  // 호스트가 목록에서 계속 위로 튀었고, 탭을 닫으면 활동 그룹에서 빠지며 또 순서가 바뀌었다 —
  // 같은 호스트를 두 번 찾게 만드는 움직임이라 정렬 기준으로 쓸 수 없다. 세션 탭이 같은 이유로
  // 정렬하지 않는다는 것은 이미 적혀 있다(useMobileAppStore 의 sortSessionsByRecency 주석:
  // "타이핑하는 중에 탭이 손가락 밑에서 맨 왼쪽으로 튄다") — 이 목록도 같은 함정이었다.
  // 최근 사용 시각은 부제(getCompactHostMeta)에 그대로 남으니 정보가 사라지는 것은 아니다.
  const sortHosts = (nextHosts: HostRecord[]) =>
    [...nextHosts].sort((left, right) => left.label.localeCompare(right.label));

  const visibleGroups = useMemo(() => {
    if (isSearching) {
      return [];
    }
    if (isFavoritesView) {
      return [];
    }
    return buildVisibleGroups(groups, hosts, currentGroupPath);
  }, [currentGroupPath, groups, hosts, isFavoritesView, isSearching]);

  // 즐겨찾기는 호스트 레코드의 favorite 필드에서 파생된다 — 데스크톱과 같은 출처이고
  // 동기화로 넘어온다.
  const favoriteHosts = useMemo(
    () => sortHosts(hosts.filter((host) => host.favorite === true)),
    [hosts],
  );

  const filteredHosts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (isFavoritesView) {
      return favoriteHosts;
    }
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
  }, [
    currentGroupPath,
    favoriteHosts,
    hosts,
    isFavoritesView,
    isSearching,
    query,
  ]);

  const listData = useMemo<HomeListItem[]>(() => {
    if (isSearching) {
      const items: HomeListItem[] = [];

      // 주소로 읽히면 맨 위. 이름만 쳐도 뜨면 검색할 때마다 이 줄을 지나쳐야 한다.
      const quickTarget = parseQuickSshInput(query);
      if (quickTarget) {
        items.push({
          kind: "action",
          action: { type: "quick-connect", target: quickTarget },
        });
      }

      for (const section of matchSettingsSections(query)) {
        items.push({ kind: "action", action: { type: "settings", section } });
      }

      // 호스트는 **카드 그대로** 둔다. 카드를 동작 줄로 바꿔 봤더니 탭 하나(접속)를 얻고
      // 길게 누르기(수정·SFTP·즐겨찾기·삭제)를 통째로 잃었다 — 검색해서 호스트를 고치는
      // 길이 사라졌다. 카드는 이미 탭이 접속이라 "바로 접속" 도 원래 되고 있었다.
      // 그래서 동작 줄은 **카드가 못 하는 것**(즉석 SSH·설정 섹션)만 맡는다.
      for (const host of filteredHosts) {
        items.push({ kind: "host", host, showGroupMeta: true });
      }

      return items;
    }

    return [
      // 루트에서만 고정한다 — 그룹 안(즐겨찾기 화면 포함)에 또 띄우면 자기 자신으로 들어가는
      // 카드가 남는다.
      ...(currentGroupPath === null && favoriteHosts.length > 0
        ? [{ kind: "favorites" as const, hostCount: favoriteHosts.length }]
        : []),
      ...visibleGroups.map((group) => ({
        kind: "group" as const,
        group,
      })),
      // 그룹 목록의 마지막 줄로 둔다 — 그룹을 만드는 일은 그룹을 보고 있을 때 생각난다.
      //
      // 카드가 아니라 조용한 한 줄이다. 처음에는 그룹 카드와 같은 크기의 점선 상자로
      // 만들었는데, 진짜 그룹처럼 보이면서 그룹·호스트 이음새에 끼어 어색했다.
      //
      // 넣지 않는 경우가 둘이다:
      //  - 검색 중·즐겨찾기 화면 — 경로가 없는 가상 목록이라 "어디에 만들지" 가 안 정해진다
      //  - 뿌리에 아무것도 없을 때 — 이 줄이 있으면 목록이 비지 않아 **빈 화면 안내가 영영
      //    안 뜬다.** 처음 쓰는 사람에게 필요한 것은 호스트를 추가하라는 안내다.
      //    (그룹 안에서는 비어 있어도 남긴다 — 방금 만든 그룹에 하위 그룹을 만들 수 있어야 한다.)
      ...(isFavoritesView ||
      (currentGroupPath === null &&
        visibleGroups.length === 0 &&
        filteredHosts.length === 0)
        ? []
        : [{ kind: "new-group" as const }]),
      ...filteredHosts.map((host) => ({
        kind: "host" as const,
        host,
        showGroupMeta: isFavoritesView,
      })),
    ];
  }, [
    currentGroupPath,
    favoriteHosts,
    filteredHosts,
    isFavoritesView,
    isSearching,
    query,
    visibleGroups,
  ]);

  // 영어는 1개일 때 문구가 달라진다("1 host"). i18next 복수형 규칙은 Intl.PluralRules
  // 가 없는 런타임이 있어 쓰지 않으므로, 데스크톱처럼 경우별 키를 골라 쓴다.
  const countLabel = useCallback(
    (key: "home.groupHostCount" | "home.folderCount", count: number): string =>
      translate(count === 1 ? `${key}One` : key, { count }),
    [translate],
  );

  const currentGroupTitle = isFavoritesView
    ? translate("home.favorites")
    : currentGroupPath
      ? groupNameByPath.get(currentGroupPath) ?? getGroupLabel(currentGroupPath)
      : "All Hosts";
  const currentGroupSubtitle = isFavoritesView
    ? countLabel("home.groupHostCount", filteredHosts.length)
    : currentGroupPath
      ? currentGroupPath
      : countLabel("home.folderCount", visibleGroups.length);

  const emptyState = useMemo(() => {
    if (isSearching) {
      return {
        title: translate("home.emptySearchTitle"),
        body: translate("home.emptySearchBody"),
      };
    }
    if (currentGroupPath) {
      return {
        title: translate("home.emptyGroupTitle"),
        body: translate("home.emptyGroupBody"),
      };
    }
    return {
      title: translate("home.emptyTitle"),
      body: translate("home.emptyBody"),
    };
  }, [currentGroupPath, isSearching]);

  const handleConnect = useCallback(
    async (host: HostRecord) => {
      setActionSheetHost(null);
      const sessionId = await connectToHost(host.id);
      if (sessionId) {
        navigation.navigate("Sessions");
      }
    },
    [connectToHost, navigation],
  );

  // SFTP 만 열고 터미널 탭은 만들지 않는다 — SFTP 세션은 자기 연결을 따로 열기 때문에
  // 터미널을 먼저 띄울 이유가 없었다(예전에는 그래서 탭이 둘 생겼다).
  const handleConnectSftp = useCallback(
    async (host: HostRecord) => {
      setActionSheetHost(null);
      const sftpSessionId = await openSftpForHost(host.id);
      if (!sftpSessionId) {
        return;
      }
      navigation.navigate("Sessions");
    },
    [navigation, openSftpForHost],
  );

  const handleEditHost = useCallback(
    (host: HostRecord) => {
      setActionSheetHost(null);
      navigation.navigate("HostForm", { hostId: host.id });
    },
    [navigation],
  );

  const handleToggleFavorite = useCallback(
    (host: HostRecord) => {
      setActionSheetHost(null);
      void toggleHostFavorite(host.id).catch((error) => {
        Alert.alert(
          translate("hostActions.favoriteFailedTitle"),
          error instanceof Error && error.message.trim()
            ? error.message
            : translate("hostActions.favoriteFailed"),
        );
      });
    },
    [toggleHostFavorite, translate],
  );

  /**
   * 그룹 편집 결과를 화면에 반영한다.
   *
   * 지운 그룹 안에 들어와 있으면 그 자리에 남을 수 없다. 이름이 바뀐 경우도 마찬가지다 —
   * 옛 경로는 더 이상 없다. 뒤로 가기 기록에도 그 경로가 남아 있으므로 같이 정리한다.
   */
  const leaveGroupPath = useCallback((removedPath: string) => {
    const isGone = (path: string | null) =>
      path !== null && (path === removedPath || path.startsWith(`${removedPath}/`));
    setCurrentGroupPath((current) => (isGone(current) ? null : current));
    setGroupHistory((history) => history.filter((path) => !isGone(path)));
  }, []);

  const runGroupMutation = useCallback(
    async (run: () => Promise<void>) => {
      setGroupBusy(true);
      try {
        await run();
        setGroupPrompt(null);
        setActionSheetGroup(null);
      } catch (error) {
        Alert.alert(
          translate("groupActions.failedTitle"),
          error instanceof Error && error.message.trim()
            ? error.message
            : translate("groupActions.failed"),
        );
      } finally {
        setGroupBusy(false);
      }
    },
    [translate],
  );

  const handleDeleteGroup = useCallback(
    (group: GroupCardView) => {
      const childGroupCount = visibleGroups.filter((candidate) =>
        candidate.path.startsWith(`${group.path}/`),
      ).length;
      const isEmpty = childGroupCount === 0 && group.hostCount === 0;

      const remove = (mode: GroupRemoveMode) => {
        void runGroupMutation(async () => {
          await removeGroup(group.path, mode);
          leaveGroupPath(group.path);
        });
      };

      Alert.alert(
        translate("groupActions.deleteTitle", { name: group.name }),
        isEmpty
          ? translate("groupActions.deleteEmptyBody")
          : translate("groupActions.deleteBody", {
              groups: childGroupCount,
              hosts: group.hostCount,
            }),
        isEmpty
          ? [
              { text: translate("common.cancel"), style: "cancel" },
              {
                text: translate("groupActions.delete"),
                style: "destructive",
                onPress: () => remove("delete-subtree"),
              },
            ]
          : [
              { text: translate("common.cancel"), style: "cancel" },
              {
                text: translate("groupActions.keepChildren"),
                onPress: () => remove("reparent-descendants"),
              },
              {
                text: translate("groupActions.deleteChildren"),
                style: "destructive",
                onPress: () => remove("delete-subtree"),
              },
            ],
      );
    },
    [leaveGroupPath, removeGroup, runGroupMutation, translate, visibleGroups],
  );

  /** 검색 결과의 동작을 실행한다. 데스크톱 팔레트의 run 콜백에 해당한다. */
  const runHomeAction = useCallback(
    async (action: HomeAction) => {
      if (action.type === "settings") {
        navigation.navigate("Settings", { section: action.section });
        return;
      }
      try {
        const sessionId = await quickConnectSsh(action.target);
        if (sessionId) {
          navigation.navigate("Sessions");
        }
      } catch (error) {
        Alert.alert(
          translate("home.action.quickConnectFailedTitle"),
          error instanceof Error && error.message.trim()
            ? error.message
            : translate("home.action.quickConnectFailed"),
        );
      }
    },
    [navigation, quickConnectSsh, translate],
  );

  const handleDeleteHost = useCallback(
    (host: HostRecord) => {
      Alert.alert(
        translate("home.deleteTitle"),
        translate("home.deleteBody", { label: host.label }),
        [
          { text: translate("common.cancel"), style: "cancel" },
          {
            text: translate("home.delete"),
            style: "destructive",
            onPress: () => {
              setActionSheetHost(null);
              void deleteHost(host.id).catch((error) => {
                Alert.alert(
                  translate("home.deleteFailedTitle"),
                  error instanceof Error && error.message.trim()
                    ? error.message
                    : translate("home.deleteFailed"),
                );
              });
            },
          },
        ],
      );
    },
    [deleteHost],
  );

  const statusBanner = useMemo(() => {
    if (auth.status === "offline-authenticated") {
      return {
        title: translate("home.offlineTitle"),
        body:
          syncStatus.errorMessage ??
          translate("home.offlineBody"),
        borderColor: palette.warning,
      };
    }

    if (syncStatus.status === "error" && syncStatus.errorMessage) {
      return {
        title: translate("home.staleTitle"),
        body: syncStatus.errorMessage,
        borderColor: palette.danger,
      };
    }

    return null;
  }, [
    auth.status,
    palette.danger,
    palette.warning,
    syncStatus,
    translate,
  ]);

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
    const subtitle = getHostSubtitle(host, hostSubtitleLabels());
    const recentActivity = recentActivityByHostId.get(host.id);
    const activityLabel = recentActivity
      ? translate("home.recentUse", { time: formatRelativeTime(recentActivity) })
      : translate("home.noSession");
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
      case "rdp":
        return "RDP";
      case "vnc":
        return "VNC";
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
        <View style={styles.searchRow}>
          <TextInput
            ref={searchInputRef}
            value={query}
            onChangeText={setQuery}
            placeholder={translate("home.searchPlaceholder")}
            placeholderTextColor={palette.mutedText}
            style={[
              styles.searchInput,
              styles.searchRowInput,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.input,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate("home.addHost")}
            onPress={() =>
              // 그룹을 열어 둔 채 추가하면 그 그룹에 넣으려는 것이다. 즐겨찾기는 진짜
              // 그룹이 아니라 호스트의 플래그라 넘기지 않는다.
              navigation.navigate(
                "HostForm",
                !isFavoritesView && currentGroupPath
                  ? { defaultGroupPath: currentGroupPath }
                  : undefined,
              )
            }
            style={[
              styles.addHostButton,
              {
                backgroundColor: palette.accentSoft,
                borderColor: palette.accent,
              },
            ]}
          >
            <Ionicons name="add" size={24} color={palette.accent} />
          </Pressable>
        </View>

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
                accessibilityLabel={translate("home.goToParentGroup")}
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
            item.kind === "favorites"
              ? "favorites"
              : item.kind === "group"
                ? `group:${item.group.path}`
                : item.kind === "new-group"
                  ? "new-group"
                  : item.kind === "action"
                    ? actionKey(item.action)
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
            if (item.kind === "favorites") {
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={translate("home.openFavorites")}
                  onPress={() => {
                    openGroup(FAVORITES_GROUP_PATH);
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
                      { backgroundColor: palette.accentSoft },
                    ]}
                  >
                    <Ionicons name="star" size={17} color={palette.accent} />
                  </View>
                  <View style={styles.groupCardCopy}>
                    <Text
                      numberOfLines={1}
                      style={[styles.groupCardTitle, { color: palette.text }]}
                    >
                      {translate("home.favorites")}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.groupCardMeta, { color: palette.mutedText }]}
                    >
                      {countLabel("home.groupHostCount", item.hostCount)}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color={palette.tabInactive}
                  />
                </Pressable>
              );
            }
            if (item.kind === "new-group") {
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={translate("groupActions.create")}
                  onPress={() => setGroupPrompt({ mode: "create" })}
                  style={[
                    styles.newGroupRow,
                    { borderColor: palette.accentBorder },
                  ]}
                >
                  <View
                    style={[
                      styles.newGroupIcon,
                      { backgroundColor: palette.accentSoft },
                    ]}
                  >
                    <Ionicons name="add" size={16} color={palette.accent} />
                  </View>
                  <Text
                    style={[styles.newGroupLabel, { color: palette.accent }]}
                  >
                    {translate("groupActions.create")}
                  </Text>
                </Pressable>
              );
            }

            if (item.kind === "group") {
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={translate("home.openGroup", { name: item.group.name })}
                  onPress={() => {
                    openGroup(item.group.path);
                  }}
                  onLongPress={() => setActionSheetGroup(item.group)}
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
                      {countLabel("home.groupHostCount", item.group.hostCount)}
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

            if (item.kind === "action") {
              const action = item.action;
              const label =
                action.type === "quick-connect"
                  ? translate("home.action.quickConnect", {
                      target: formatQuickSshHostLabel(action.target),
                    })
                  : translate("home.action.settings", {
                      section: translate(`settings.sections.${action.section}`),
                    });
              const icon =
                action.type === "quick-connect"
                  ? "flash-outline"
                  : "settings-outline";
              // 즉석 접속은 무엇을 만들며 붙는지 아래 줄에 남긴다 — 오타 난 주소로 호스트가
              // 생기는 것을 누르기 전에 알아야 한다.
              const actionMeta =
                action.type === "quick-connect"
                  ? translate("home.action.quickConnectMeta")
                  : null;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  onPress={() => void runHomeAction(action)}
                  style={[
                    styles.actionRow,
                    {
                      backgroundColor: palette.surface,
                      borderColor: palette.border,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.groupIcon,
                      { backgroundColor: palette.accentSoft },
                    ]}
                  >
                    <Ionicons name={icon} size={18} color={palette.accent} />
                  </View>
                  <View style={styles.actionText}>
                    <Text
                      numberOfLines={1}
                      style={[styles.actionLabel, { color: palette.text }]}
                    >
                      {label}
                    </Text>
                    {actionMeta ? (
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.actionMeta,
                          { color: palette.mutedText },
                        ]}
                      >
                        {actionMeta}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            }


            const searchGroupMeta = item.showGroupMeta
              ? getSearchGroupMeta(item.host)
              : null;
            const compactMeta = getCompactHostMeta(item.host);

            return (
              <Pressable
                accessibilityRole="button"
                // 그룹 카드에는 라벨이 있는데 호스트 카드에는 없었다. 스크린리더가 카드 안의
                // 글자를 죄다 읽어 주는 대신 무엇을 누르는 것인지 먼저 알려 준다.
                accessibilityLabel={translate("home.connectHost", {
                  name: item.host.label,
                })}
                onPress={() => void handleConnect(item.host)}
                onLongPress={() => setActionSheetHost(item.host)}
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
                    {translate("home.groupMeta", { meta: searchGroupMeta })}
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

        <GroupActionSheet
          group={actionSheetGroup}
          onClose={() => setActionSheetGroup(null)}
          onRename={(group) => {
            // 시트를 **반드시 먼저 닫는다.** Modal 두 개가 겹치면 시트가 위를 덮어 입력
            // 모달의 탭이 전부 시트로 간다(눌러도 아무 일이 없는 것처럼 보인다).
            setActionSheetGroup(null);
            const next = { mode: "rename" as const, group };
            if (Platform.OS === "ios") {
              // iOS 는 닫히는 도중에 띄우면 무시한다 — onDismissed 를 기다린다.
              setPendingGroupPrompt(next);
              return;
            }
            setGroupPrompt(next);
          }}
          onDismissed={() => {
            if (pendingGroupPrompt) {
              setGroupPrompt(pendingGroupPrompt);
              setPendingGroupPrompt(null);
            }
          }}
          onDelete={handleDeleteGroup}
        />

        <GroupNamePromptModal
          visible={groupPrompt !== null}
          busy={groupBusy}
          title={
            groupPrompt?.mode === "rename"
              ? translate("groupActions.renameTitle")
              : translate("groupActions.createTitle")
          }
          initialValue={
            groupPrompt?.mode === "rename" ? groupPrompt.group.name : ""
          }
          hint={
            groupPrompt?.mode === "create" && currentGroupPath
              ? translate("groupActions.createHint", { path: currentGroupPath })
              : null
          }
          submitLabel={
            groupPrompt?.mode === "rename"
              ? translate("groupActions.rename")
              : translate("groupActions.create")
          }
          onClose={() => setGroupPrompt(null)}
          onSubmit={(name) => {
            if (!groupPrompt) {
              return;
            }
            void runGroupMutation(async () => {
              if (groupPrompt.mode === "rename") {
                await renameGroup(groupPrompt.group.path, name);
                // 이름이 바뀌면 옛 경로는 사라진다. 그 안에 들어와 있었다면 나와야 한다.
                leaveGroupPath(groupPrompt.group.path);
                return;
              }
              await createGroup(name, currentGroupPath);
            });
          }}
        />

        <HostActionSheet
          host={actionSheetHost}
          onClose={() => setActionSheetHost(null)}
          onConnect={(host) => void handleConnect(host)}
          onConnectSftp={(host) => void handleConnectSftp(host)}
          onEdit={handleEditHost}
          onDelete={handleDeleteHost}
          onToggleFavorite={handleToggleFavorite}
        />
      </View>
    </IosEdgeSwipeBack>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchRowInput: {
    flex: 1,
  },
  addHostButton: {
    width: 48,
    height: 48,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
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
  // 검색 결과의 동작 줄. 호스트 카드와 같은 크기라 목록의 리듬이 유지된다.
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  actionText: {
    flex: 1,
    gap: 2,
  },
  actionLabel: {
    fontSize: 15,
    fontWeight: "700",
  },
  actionMeta: {
    fontSize: 12,
  },
  // 그룹 카드와 같은 알약 모양이되 **높이를 낮추고 점선**으로 둔다 — 채워진 카드가 아니라
  // "여기에 하나 만들 수 있다" 는 자리로 읽혀야 한다. 아이콘 타일도 40 이 아니라 28 이다.
  //
  // 참고: 안드로이드는 borderRadius 가 있으면 점선을 실선으로 그린다(RN 제약). 그때는
  // 연한 실선 테두리 알약으로 보이며, 그래도 카드와는 구분된다.
  newGroupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  newGroupIcon: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  newGroupLabel: {
    fontSize: 14,
    fontWeight: "700",
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
