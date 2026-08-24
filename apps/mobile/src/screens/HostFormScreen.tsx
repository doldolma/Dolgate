import React, { useEffect, useCallback, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NavigationProp, RouteProp } from "@react-navigation/native";
import {
  collectGroupPaths,
  isRdpHostRecord,
  isSshHostRecord,
  isVncHostRecord,
  normalizeGroupPath,
  normalizeJumpHostIds,
} from "@dolssh/shared-core";
import type {
  AuthType,
  AwsEc2HostRecord,
  HostEnvVar,
  HostStartupCommand,
} from "@dolssh/shared-core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { SettingsGroup, SettingsRow } from "../components/SettingsList";
import Ionicons from "react-native-vector-icons/Ionicons";
import {
  ChipField,
  FieldRow,
  HostKindField,
  Segmented,
  type HostFormKind,
} from "../components/HostFormFields";
import { resolveCreatableHostFormKinds } from "../lib/host-form-kinds";
import { GroupNamePromptModal } from "../components/GroupNamePromptModal";
import { ListPickerModal } from "../components/ListPickerModal";
import { RemoteDesktopHostFormScreen } from "./RemoteDesktopHostFormScreen";
import { StartupSnippetPickerModal } from "../components/StartupSnippetPickerModal";
import { hasSnippetVariables } from "../lib/snippet-variables";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";
import { useTranslation } from "react-i18next";

// 폼에서 직접 고를 수 있는 방식. 데스크톱의 'agent' 는 빠져 있다 — 서명을 로컬 ssh-agent
// 소켓에 위임하는 방식이라 그 프로세스가 없는 iOS·Android 에서는 성립하지 않는다.
type HostAuthType = "password" | "privateKey" | "certificate";
type CredentialMode = "preserve" | "replace" | "remove";

type StartupMode = "none" | "command" | "snippet";

const STARTUP_MODE_OPTIONS: Array<{ value: StartupMode; labelKey: string }> = [
  { value: "none", labelKey: "hostForm.startup.modeNone" },
  { value: "command", labelKey: "hostForm.startup.modeCommand" },
  { value: "snippet", labelKey: "hostForm.startup.modeSnippet" },
];

/**
 * 폼 상태를 저장 payload 로 바꾼다.
 *
 * 항상 값이나 `null` 을 돌려준다 — `undefined`(보존)는 이 화면이 쓸 일이 없다. 사용자가
 * "사용 안 함"을 골랐으면 그건 해제를 뜻하므로 `null` 이어야 한다.
 */
function buildStartupCommandPayload(input: {
  mode: StartupMode;
  command: string;
  snippetId: string | null;
}): HostStartupCommand | null {
  if (input.mode === "command") {
    const command = input.command.trim();
    return command ? { type: "command", command: input.command } : null;
  }
  if (input.mode === "snippet" && input.snippetId) {
    return { type: "snippet", snippetId: input.snippetId };
  }
  return null;
}

const AUTH_TYPE_OPTIONS: Array<{ value: HostAuthType; labelKey: string }> = [
  { value: "password", labelKey: "hostForm.auth.password" },
  { value: "privateKey", labelKey: "hostForm.auth.privateKey" },
  { value: "certificate", labelKey: "hostForm.auth.certificate" },
];

const CREDENTIAL_MODE_OPTIONS: Array<{
  value: CredentialMode;
  labelKey: string;
}> = [
  { value: "preserve", labelKey: "hostForm.credential.preserve" },
  { value: "replace", labelKey: "hostForm.credential.replace" },
  { value: "remove", labelKey: "hostForm.credential.remove" },
];

// 개인 키를 받는 방식들 — 인증서 인증도 서명은 개인 키로 하고 인증서를 함께 제시한다.
function usesPrivateKey(authType: HostAuthType): boolean {
  return authType === "privateKey" || authType === "certificate";
}

function isFormAuthType(authType: AuthType): authType is HostAuthType {
  return (
    authType === "password" ||
    authType === "privateKey" ||
    authType === "certificate"
  );
}

// 폼이 다루지 않는 방식의 라벨. 값을 바꾸진 않지만 무엇으로 설정돼 있는지는 보여 줘야 한다 —
// 안 보여 주면 사용자가 비밀번호로 되어 있다고 오해한다.
const LOCKED_AUTH_LABEL_KEYS = {
  agent: "hostForm.auth.agent",
  keyboardInteractive: "hostForm.auth.keyboardInteractive",
} as const satisfies Record<Exclude<AuthType, HostAuthType>, string>;

// 스토어(MOBILE_MAX_JUMP_CHAIN)와 같은 값이어야 한다 — 폼에서 더 넣게 두면 저장은 되고
// 접속만 거부된다.
const MAX_JUMP_HOSTS = 8;

interface PasteFieldProps {
  label: string;
  value: string;
  placeholder: string;
  onChangeText: (next: string) => void;
}

// 키·인증서는 한 줄에 들어가지 않는다 — 라벨을 위로 올리고 아래를 붙여넣기 영역으로 쓴다.
function PasteField({
  label,
  value,
  placeholder,
  onChangeText,
}: PasteFieldProps): React.JSX.Element {
  const palette = useMobilePalette();
  return (
    <View style={styles.pasteField}>
      <Text style={[styles.pasteLabel, { color: palette.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.tabInactive}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.pasteInput,
          {
            color: palette.text,
            backgroundColor: palette.input,
            borderColor: palette.border,
          },
        ]}
      />
    </View>
  );
}

// SSH 호스트 생성·수정 폼. 데스크톱 전용 고급 필드(jump host·환경변수·시작 명령 등)는
// 다루지 않는다 — 수정 시 스토어(saveHost)가 기존 값을 그대로 보존한다.
/**
 * EC2 호스트 화면. 편집할 수 있는 것은 **서버 프록시 하나**다.
 *
 * 인스턴스·리전·계정은 AWS 가 정하고 동기화로 들어오는 값이라 기기에서 고칠 것이 아니다. 반면
 * 접속 경로는 기기 사정에 따라 달라진다 — 그래서 이 토글만 여기 둔다.
 */
function AwsEc2HostForm({ host }: { host: AwsEc2HostRecord }): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding({ includeSafeTop: false });
  const setServerProxy = useMobileAppStore(
    (state) => state.setAwsSsmServerProxyEnabled,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = host.awsSsmServerProxyEnabled === true;

  const toggle = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await setServerProxy(host.id, !enabled);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : translate("hostForm.ec2.proxySaveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }, [enabled, host.id, setServerProxy, translate]);

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: palette.background }]}
      contentContainerStyle={[
        styles.content,
        {
          paddingHorizontal: screenPadding.paddingHorizontal,
          paddingTop: 14,
          paddingBottom: screenPadding.paddingBottom,
        },
      ]}
    >
      <SettingsGroup header={translate("hostForm.ec2.instanceSection")}>
        <SettingsRow label={translate("hostForm.fields.name")} value={host.label} />
        <SettingsRow
          label={translate("hostForm.ec2.instanceId")}
          value={host.awsInstanceId}
        />
        <SettingsRow label={translate("hostForm.ec2.region")} value={host.awsRegion} />
        <SettingsRow
          label={translate("hostForm.ec2.profile")}
          value={host.awsProfileName}
        />
      </SettingsGroup>

      <SettingsGroup
        header={translate("hostForm.ec2.connectionSection")}
        footer={translate("hostForm.ec2.serverProxyHint")}
      >
        <SettingsRow label={translate("hostForm.ec2.serverProxy")}>
          <View style={styles.ec2ToggleRow}>
            <Text style={[styles.ec2ToggleLabel, { color: palette.text }]}>
              {translate("hostForm.ec2.serverProxy")}
            </Text>
            <Switch value={enabled} onValueChange={toggle} disabled={saving} />
          </View>
        </SettingsRow>
      </SettingsGroup>

      {error ? (
        <Text style={[styles.ec2Error, { color: palette.danger }]}>{error}</Text>
      ) : null}
    </ScrollView>
  );
}

export function HostFormScreen(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  // 네비게이션 헤더가 위를 덮으므로 안전 영역은 그쪽이 이미 처리했다.
  const screenPadding = useScreenPadding({ includeSafeTop: false });
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, "HostForm">>();
  const hostId = route.params?.hostId;
  const hosts = useMobileAppStore((state) => state.hosts);
  const saveHost = useMobileAppStore((state) => state.saveHost);
  const createGroup = useMobileAppStore((state) => state.createGroup);
  const dataFloorServerSupport = useMobileAppStore(
    (state) => state.syncStatus.dataFloorServerSupport,
  );

  const existing = useMemo(() => {
    if (!hostId) {
      return null;
    }
    const found = hosts.find((host) => host.id === hostId);
    return found && isSshHostRecord(found) ? found : null;
  }, [hostId, hosts]);

  // RDP·VNC 는 필드가 겹치지 않아 화면을 따로 쓴다. 종류는 고칠 때는 레코드가, 만들 때는
  // 라우트 파라미터가 정한다.
  const editingRemoteDesktop = useMemo(() => {
    if (!hostId) {
      return false;
    }
    const found = hosts.find((host) => host.id === hostId);
    return Boolean(found && (isRdpHostRecord(found) || isVncHostRecord(found)));
  }, [hostId, hosts]);
  // 만들 때의 종류는 폼 안에서 고른다. 기본은 SSH — 폼을 열자마자 골라져 있어서 가장 흔한
  // 길에는 손이 더 들지 않는다.
  const [createKind, setCreateKind] = useState<HostFormKind>(
    route.params?.kind ?? "ssh",
  );
  const creatingRemoteDesktop = !hostId && createKind !== "ssh";
  // RDP·VNC 는 서버가 계정 데이터 수준을 판정할 때만 만들 수 있다 — 못 막는 서버에서 만들면
  // 같은 계정의 옛 기기가 그 레코드를 받고 조용히 망가진다.
  const creatableKinds = useMemo(
    () =>
      resolveCreatableHostFormKinds({
        serverSupportsDataFloor: dataFloorServerSupport === "supported",
      }),
    [dataFloorServerSupport],
  );

  // **EC2 호스트는 이 폼이 편집하지 않는다.** 인스턴스 정보는 AWS 가 정하고 동기화로 들어온다.
  // 다만 접속 경로를 정하는 서버 프록시는 기기에서 바꿀 수 있어야 해서 그 한 가지만 갈라 준다.
  const editingEc2Host = useMemo(() => {
    if (!hostId) {
      return null;
    }
    const found = hosts.find((host) => host.id === hostId);
    return found && found.kind === "aws-ec2" ? found : null;
  }, [hostId, hosts]);
  // 데스크톱에서만 설정할 수 있는 방식은 잠근다. 이걸 password 로 떨어뜨리면 이름만 고쳐
  // 저장해도 authType 이 password 로 덮어써져 데스크톱에서도 그 호스트가 깨진다.
  const lockedAuthType =
    existing && !isFormAuthType(existing.authType) ? existing.authType : null;
  const initialAuthType: HostAuthType =
    existing?.authType === "privateKey" || existing?.authType === "certificate"
      ? existing.authType
      : "password";

  const [label, setLabel] = useState(existing?.label ?? "");
  const [hostname, setHostname] = useState(existing?.hostname ?? "");
  const [portDraft, setPortDraft] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? "");
  const [authType, setAuthType] = useState<HostAuthType>(initialAuthType);
  // 채워 넣은 기본 그룹은 **사용자가 고친 것이 아니다.** 변경 판정 기준선도 이 값이어야
  // 한다 — 아니면 아무것도 안 건드리고 나가려 할 때 "변경 사항을 버릴까요?" 가 뜬다.
  const initialGroupName =
    existing?.groupName ?? route.params?.defaultGroupPath ?? "";
  const [groupName, setGroupName] = useState(initialGroupName);
  const [password, setPassword] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [certificateText, setCertificateText] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const initialCredentialMode: CredentialMode =
    existing?.secretRef && existing.authType === initialAuthType
      ? "preserve"
      : "replace";
  const [credentialMode, setCredentialMode] =
    useState<CredentialMode>(initialCredentialMode);
  const [saving, setSaving] = useState(false);

  const snippets = useMobileAppStore((state) => state.snippets);
  const tailnets = useMobileAppStore((state) => state.tailnets);
  const groups = useMobileAppStore((state) => state.groups);
  const initialStartup = existing?.startupCommand ?? null;
  const initialStartupMode: StartupMode =
    initialStartup?.type === "command"
      ? "command"
      : initialStartup?.type === "snippet"
        ? "snippet"
        : "none";
  const [startupMode, setStartupMode] =
    useState<StartupMode>(initialStartupMode);
  const [startupCommand, setStartupCommand] = useState(
    initialStartup?.type === "command" ? initialStartup.command : "",
  );
  const [startupSnippetId, setStartupSnippetId] = useState<string | null>(
    initialStartup?.type === "snippet" ? initialStartup.snippetId : null,
  );
  const [snippetPickerOpen, setSnippetPickerOpen] = useState(false);

  // 고급 항목. 데스크톱에서 넣어 둔 값은 모바일이 **보존만** 하고 있었다 — 이제 여기서 고친다.
  const initialTags = existing?.tags ?? [];
  const initialEnv = existing?.env ?? [];
  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagDraft, setTagDraft] = useState("");
  const [envVars, setEnvVars] = useState<HostEnvVar[]>(initialEnv);
  const [agentForwarding, setAgentForwarding] = useState(
    existing?.agentForwarding === true,
  );
  const [useMosh, setUseMosh] = useState(existing?.useMosh === true);
  // 값이 들어 있으면 펼친 채로 연다. 접힌 채로 두면 데스크톱에서 넣은 설정이 사라진 것처럼
  // 보인다 — 보존하고 있다는 사실이 눈에 보여야 한다.
  const [envNameDraft, setEnvNameDraft] = useState("");
  const [envValueDraft, setEnvValueDraft] = useState("");
  const initialJumpHostIds = normalizeJumpHostIds(
    existing?.jumpHostIds,
    existing?.jumpHostId,
  );
  const [jumpHostIds, setJumpHostIds] =
    useState<string[]>(initialJumpHostIds);
  const initialTailnetId = existing?.tailnetId ?? null;
  const [tailnetId, setTailnetId] = useState<string | null>(initialTailnetId);
  const [picker, setPicker] = useState<
    'group' | 'tailnet' | 'jump' | null
  >(null);
  const [groupPromptOpen, setGroupPromptOpen] = useState(false);
  const [groupBusy, setGroupBusy] = useState(false);
  // 언제나 접힌 채로 연다.
  //
  // 값이 있으면 펼쳐 두게 했더니 태그 하나만 넣어도 그 뒤로는 영영 열려 있어서 접는 뜻이
  // 없어졌다. 안에 무엇이 들었는지는 머리글의 요약이 알려 준다.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const selectedSnippet = useMemo(
    () =>
      startupSnippetId
        ? (snippets.find((entry) => entry.id === startupSnippetId) ?? null)
        : null,
    [snippets, startupSnippetId],
  );
  // 데스크톱에서 스니펫을 지운 경우. 접속은 건너뛰고 여기서만 알린다.
  const startupSnippetMissing = Boolean(startupSnippetId && !selectedSnippet);
  const startupHasVariables = Boolean(
    selectedSnippet && hasSnippetVariables(selectedSnippet.command),
  );

  // 저장에 성공해 스스로 닫는 경우와 사용자가 도중에 나가는 경우를 구분한다 — 구분하지 않으면
  // 저장 직후에도 "변경 사항을 버릴까요?"가 뜬다.
  const savedRef = useRef(false);
  const isDirty =
    label !== (existing?.label ?? "") ||
    hostname !== (existing?.hostname ?? "") ||
    portDraft !== String(existing?.port ?? 22) ||
    username !== (existing?.username ?? "") ||
    groupName !== initialGroupName ||
    tags.join('\u0000') !== initialTags.join('\u0000') ||
    envVars.map(item => `${item.key}=${item.value}`).join('\u0000') !==
      initialEnv.map(item => `${item.key}=${item.value}`).join('\u0000') ||
    agentForwarding !== (existing?.agentForwarding === true) ||
    useMosh !== (existing?.useMosh === true) ||
    jumpHostIds.join('\u0000') !== initialJumpHostIds.join('\u0000') ||
    tailnetId !== initialTailnetId ||
    authType !== initialAuthType ||
    credentialMode !== initialCredentialMode ||
    // startup 항목을 빠뜨리면 그것만 고치고 나갈 때 확인 없이 입력이 사라진다.
    startupMode !== initialStartupMode ||
    startupCommand !==
      (initialStartup?.type === "command" ? initialStartup.command : "") ||
    startupSnippetId !==
      (initialStartup?.type === "snippet" ? initialStartup.snippetId : null) ||
    Boolean(password || privateKeyPem || certificateText || passphrase);

  // 헤더의 취소와 아래로 스와이프하는 모달 제스처가 같은 곳을 지나게 한다 — 한쪽만 확인을
  // 받으면 어느 쪽으로 나갔는지에 따라 입력이 조용히 사라진다.
  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (event) => {
      if (savedRef.current || !isDirty) {
        return;
      }
      event.preventDefault();
      Alert.alert(
        translate("hostForm.discardTitle"),
        translate("hostForm.discardBody"),
        [
          { text: translate("hostForm.keepEditing"), style: "cancel" },
          {
            text: translate("hostForm.discardConfirm"),
            style: "destructive",
            onPress: () => navigation.dispatch(event.data.action),
          },
        ],
      );
    });
    return unsubscribe;
  }, [isDirty, navigation, translate]);

  // 저장된 자격 증명이 있고 방식도 그대로일 때만 "기존 유지/교체/연결 해제"를 고를 수 있다.
  const canChooseCredentialMode = Boolean(
    !lockedAuthType && existing?.secretRef && existing.authType === authType,
  );
  const showsCredentialFields =
    !lockedAuthType && (!canChooseCredentialMode || credentialMode === "replace");

  const port = Number.parseInt(portDraft, 10);
  const validationMessage = (() => {
    if (!label.trim()) {
      return translate("hostForm.validation.name");
    }
    if (!hostname.trim()) {
      return translate("hostForm.validation.host");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return translate("hostForm.validation.port");
    }
    if (!username.trim()) {
      return translate("hostForm.validation.username");
    }
    // 인증서 인증은 둘이 한 쌍이다. 한쪽만 채우면 저장은 되는데 시크릿이 만들어지지 않아
    // 조용히 버려지므로 여기서 막는다.
    if (
      showsCredentialFields &&
      authType === "certificate" &&
      Boolean(privateKeyPem.trim()) !== Boolean(certificateText.trim())
    ) {
      return translate("hostForm.validation.certificatePair");
    }
    return null;
  })();
  const canSave = !saving && !validationMessage;

  const selectAuthType = (next: HostAuthType): void => {
    setAuthType(next);
    setCredentialMode(
      existing?.secretRef && existing.authType === next ? "preserve" : "replace",
    );
  };

  const selectedTailnet = tailnets.find(item => item.id === tailnetId) ?? null;
  // 점프 홉은 자기 자신을 넣을 수 없고(순환), SSH 호스트만 후보다.
  const jumpCandidates = hosts
    .filter(isSshHostRecord)
    .filter(host => host.id !== hostId);
  const groupPaths = collectGroupPaths(groups, hosts);

  // 접힌 머리글에 개수를 적는다 — 안에 무엇이 들었는지 열어 보지 않아도 알 수 있게.
  const advancedSummary = [
    startupMode !== "none" ? translate("hostForm.startup.count") : null,
    tags.length > 0 ? translate("hostForm.tags.count", { count: tags.length }) : null,
    envVars.length > 0
      ? translate("hostForm.env.count", { count: envVars.length })
      : null,
    jumpHostIds.length > 0
      ? translate("hostForm.jump.count", { count: jumpHostIds.length })
      : null,
    selectedTailnet ? selectedTailnet.label : null,
    agentForwarding ? translate("hostForm.toggles.agentForwarding") : null,
    useMosh ? translate("hostForm.toggles.mosh") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  // 없는 그룹은 여기서 만든다 — 직접 타이핑하던 시절에는 오타가 그대로 새 그룹이 되었다.
  // 지금 고른 그룹 아래에 만들고, 어디에 만들어지는지는 프롬프트가 먼저 알려 준다.
  const handleCreateGroup = async (name: string): Promise<void> => {
    const parentPath = groupName || null;
    setGroupBusy(true);
    try {
      await createGroup(name, parentPath);
      const created = normalizeGroupPath(
        parentPath ? `${parentPath}/${name.trim()}` : name.trim(),
      );
      if (created) {
        setGroupName(created);
      }
      setGroupPromptOpen(false);
      setPicker(null);
    } catch (error) {
      Alert.alert(
        translate("groupActions.failedTitle"),
        error instanceof Error && error.message
          ? error.message
          : translate("groupActions.failed"),
      );
    } finally {
      setGroupBusy(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await saveHost({
        hostId,
        label,
        hostname,
        port,
        username,
        authType: lockedAuthType ?? authType,
        groupName: groupName.trim() ? groupName : null,
        // 잠긴 방식은 자격 증명을 건드리지 않는다. 모드 판단은 스토어 기본값에 맡긴다 —
        // preserve 를 직접 넘기면 시크릿이 없는 호스트(agent 가 그렇다)에서 거부된다.
        credentialMode: lockedAuthType ? undefined : credentialMode,
        credentials: lockedAuthType
          ? null
          : {
              password: authType === "password" ? password : undefined,
              privateKeyPem: usesPrivateKey(authType)
                ? privateKeyPem
                : undefined,
              passphrase: usesPrivateKey(authType) ? passphrase : undefined,
              certificateText:
                authType === "certificate" ? certificateText : undefined,
            },
        tags,
        // 빈 배열은 "전부 지워라" 다 — 값이 없으면 null 로 보내 해제한다.
        env: envVars.length > 0 ? envVars : null,
        agentForwarding,
        useMosh,
        // 목록은 빈 배열과 null 이 다른 뜻이다 — 비웠으면 해제로 보낸다.
        jumpHostIds: jumpHostIds.length > 0 ? jumpHostIds : null,
        tailnetId,
        startupCommand: buildStartupCommandPayload({
          mode: startupMode,
          command: startupCommand,
          snippetId: startupSnippetId,
        }),
      });
      savedRef.current = true;
      navigation.goBack();
    } catch (error) {
      Alert.alert(
        translate(hostId ? "hostForm.editFailedTitle" : "hostForm.addFailedTitle"),
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("hostForm.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const credentialFooter = (() => {
    if (!canChooseCredentialMode) {
      return undefined;
    }
    if (credentialMode === "preserve") {
      return translate("hostForm.credential.preserveHint");
    }
    if (credentialMode === "remove") {
      return translate("hostForm.credential.removeHint");
    }
    return undefined;
  })();

  if (editingEc2Host) {
    return (
      <AwsEc2HostForm host={editingEc2Host} />
    );
  }

  if (editingRemoteDesktop || creatingRemoteDesktop) {
    return (
      <RemoteDesktopHostFormScreen
        createKind={hostId ? null : createKind}
        creatableKinds={creatableKinds}
        onCreateKindChange={setCreateKind}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: palette.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingHorizontal: screenPadding.paddingHorizontal,
            paddingTop: 14,
            paddingBottom: screenPadding.paddingBottom,
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {!hostId ? (
          <HostKindField
            kind={createKind}
            kinds={creatableKinds}
            onChange={setCreateKind}
            label={translate("hostForm.kindSection")}
            disabledHint={translate("hostForm.kindUnsupported")}
          />
        ) : null}

        <SettingsGroup
          header={translate("hostForm.basicSection")}
          footer={translate("hostForm.groupHint")}
        >
          <FieldRow
            label={translate("hostForm.fields.name")}
            value={label}
            placeholder={translate("hostForm.namePlaceholder")}
            onChangeText={setLabel}
            autoCapitalize="sentences"
          />
          <FieldRow
            label={translate("hostForm.fields.host")}
            value={hostname}
            placeholder={translate("hostForm.hostPlaceholder")}
            onChangeText={setHostname}
          />
          <FieldRow
            label={translate("hostForm.fields.port")}
            value={portDraft}
            placeholder={translate("hostForm.portPlaceholder")}
            onChangeText={setPortDraft}
            keyboardType="number-pad"
          />
          <FieldRow
            label={translate("hostForm.fields.username")}
            value={username}
            placeholder={translate("hostForm.usernamePlaceholder")}
            onChangeText={setUsername}
          />
          {/* 그룹은 고르는 것이지 타이핑하는 것이 아니다 — 직접 입력을 남겨 두면 오타가 곧
              새 그룹이 된다. 없는 그룹은 고르는 화면 안에서 만든다. */}
          <SettingsRow
            icon="folder-outline"
            label={translate("hostForm.fields.group")}
            value={groupName || translate("hostForm.group.none")}
            chevron
            onPress={() => setPicker("group")}
          />
        </SettingsGroup>

        {lockedAuthType ? (
          <SettingsGroup
            header={translate("hostForm.authSection")}
            footer={translate("hostForm.auth.lockedHint")}
          >
            <SettingsRow
              icon="key-outline"
              label={translate(LOCKED_AUTH_LABEL_KEYS[lockedAuthType])}
            />
          </SettingsGroup>
        ) : (
          <View style={styles.authSection}>
            <Text style={[styles.sectionHeader, { color: palette.text }]}>
              {translate("hostForm.authSection")}
            </Text>
            <Segmented
              options={AUTH_TYPE_OPTIONS.map((option) => ({
                value: option.value,
                label: translate(option.labelKey),
              }))}
              selected={authType}
              onSelect={selectAuthType}
            />
          </View>
        )}

        {canChooseCredentialMode ? (
          <SettingsGroup
            header={translate("hostForm.credentialSection")}
            footer={credentialFooter}
          >
            {CREDENTIAL_MODE_OPTIONS.map((option) => (
              <SettingsRow
                key={option.value}
                label={translate(option.labelKey)}
                tone={option.value === "remove" ? "danger" : "default"}
                check={credentialMode === option.value}
                onPress={() => setCredentialMode(option.value)}
              />
            ))}
          </SettingsGroup>
        ) : null}

        {showsCredentialFields ? (
          <SettingsGroup footer={translate("hostForm.syncHint")}>
            {authType === "password" ? (
              <FieldRow
                label={translate("hostForm.fields.password")}
                value={password}
                placeholder={translate("hostForm.passwordPlaceholder")}
                onChangeText={setPassword}
                secureTextEntry
              />
            ) : null}
            {usesPrivateKey(authType) ? (
              <PasteField
                label={translate("hostForm.fields.privateKey")}
                value={privateKeyPem}
                placeholder={translate("hostForm.privateKeyPlaceholder")}
                onChangeText={setPrivateKeyPem}
              />
            ) : null}
            {authType === "certificate" ? (
              <PasteField
                label={translate("hostForm.fields.certificate")}
                value={certificateText}
                placeholder={translate("hostForm.certificatePlaceholder")}
                onChangeText={setCertificateText}
              />
            ) : null}
            {usesPrivateKey(authType) ? (
              <FieldRow
                label={translate("hostForm.fields.passphrase")}
                value={passphrase}
                placeholder={translate("hostForm.passphrasePlaceholder")}
                onChangeText={setPassphrase}
                secureTextEntry
              />
            ) : null}
          </SettingsGroup>
        ) : null}

        {validationMessage && (label || hostname || username) ? (
          <Text style={[styles.errorText, { color: palette.warning }]}>
            {validationMessage}
          </Text>
        ) : null}

        {/* 고급 — 평소에는 접어 둔다. 대부분의 사람이 쓰는 것(이름·주소·사용자·비밀번호)이
            안 쓰는 항목들 사이에 묻히면 안 된다. 값이 있으면 펼친 채로 연다.

            머리글은 카드가 아니라 구획 이름이다 — 카드에 넣으면 설정 항목 하나처럼 보여서
            누르면 무엇이 열리는지 읽히지 않는다. */}
        <Pressable
          onPress={() => setAdvancedOpen(open => !open)}
          accessibilityRole="button"
          accessibilityLabel={translate("hostForm.advancedSection")}
          accessibilityState={{ expanded: advancedOpen }}
          style={styles.advancedHeader}
        >
          <Text style={[styles.advancedTitle, { color: palette.text }]}>
            {translate("hostForm.advancedSection")}
          </Text>
          <Ionicons
            name={advancedOpen ? "chevron-down" : "chevron-forward"}
            size={15}
            color={palette.tabInactive}
          />
          <View style={styles.advancedSpacer} />
          {!advancedOpen && advancedSummary ? (
            <Text
              numberOfLines={1}
              style={[styles.advancedSummary, { color: palette.mutedText }]}
            >
              {advancedSummary}
            </Text>
          ) : null}
        </Pressable>

        {advancedOpen ? (
          <>
            <SettingsGroup footer={translate("hostForm.toggles.hint")}>
              <ChipField
                label={translate("hostForm.tags.header")}
                chips={tags.map(tag => ({ id: tag, text: tag }))}
                removeLabel={chip =>
                  translate("hostForm.tags.remove", { tag: chip.text })
                }
                onRemove={tag =>
                  setTags(current => current.filter(item => item !== tag))
                }
                input={{
                  value: tagDraft,
                  label: translate("hostForm.tags.add"),
                  placeholder: translate("hostForm.tags.placeholder"),
                  onChangeText: setTagDraft,
                  onSubmit: () => {
                    const next = tagDraft.trim();
                    if (!next || tags.includes(next)) {
                      setTagDraft("");
                      return;
                    }
                    setTags(current => [...current, next]);
                    setTagDraft("");
                  },
                }}
              />
              <ChipField
                label={translate("hostForm.env.header")}
                chips={envVars.map(item => ({
                  id: item.key,
                  text: `${item.key}=${item.value}`,
                }))}
                removeLabel={chip =>
                  translate("hostForm.env.remove", { key: chip.id })
                }
                onRemove={key =>
                  setEnvVars(current => current.filter(item => item.key !== key))
                }
                pairInput={{
                  name: {
                    value: envNameDraft,
                    label: translate("hostForm.env.nameLabel"),
                    placeholder: translate("hostForm.env.namePlaceholder"),
                    onChangeText: setEnvNameDraft,
                  },
                  value: {
                    value: envValueDraft,
                    label: translate("hostForm.env.valueLabel"),
                    placeholder: translate("hostForm.env.valuePlaceholder"),
                    onChangeText: setEnvValueDraft,
                  },
                  addLabel: translate("hostForm.env.add"),
                  onSubmit: () => {
                    const key = envNameDraft.trim();
                    if (!key) {
                      return;
                    }
                    // 같은 이름을 다시 넣으면 덮어쓴다 — 같은 변수가 두 줄 있으면 어느 쪽이
                    // 적용되는지 알 수 없다.
                    setEnvVars(current => [
                      ...current.filter(item => item.key !== key),
                      { key, value: envValueDraft.trim() },
                    ]);
                    setEnvNameDraft("");
                    setEnvValueDraft("");
                  },
                }}
              />
              <ChipField
                label={translate("hostForm.jump.header")}
                chips={jumpHostIds.map((id, index) => ({
                  id,
                  text: `${index + 1}. ${
                    hosts.find(item => item.id === id)?.label ?? id
                  }`,
                }))}
                removeLabel={chip =>
                  translate("hostForm.jump.remove", { label: chip.text })
                }
                onRemove={id =>
                  setJumpHostIds(current => current.filter(item => item !== id))
                }
                action={{
                  label: translate("common.add"),
                  accessibilityLabel: translate("hostForm.jump.add"),
                  onPress: () => setPicker("jump"),
                }}
              />
              <SettingsRow
                label={translate("hostForm.tailnet.label")}
                value={
                  selectedTailnet?.label ?? translate("hostForm.tailnet.none")
                }
                chevron
                onPress={() => setPicker("tailnet")}
              />
              <SettingsRow
                label={translate("hostForm.toggles.agentForwarding")}
                toggle={{
                  value: agentForwarding,
                  onValueChange: setAgentForwarding,
                }}
              />
              <SettingsRow
                label={translate("hostForm.toggles.mosh")}
                toggle={{ value: useMosh, onValueChange: setUseMosh }}
              />
            </SettingsGroup>

            <View style={styles.authSection}>
              <Text style={[styles.sectionHeader, { color: palette.text }]}>
                {translate("hostForm.startupSection")}
              </Text>
              <Segmented
                options={STARTUP_MODE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: translate(option.labelKey),
                }))}
                selected={startupMode}
                onSelect={setStartupMode}
              />
              <Text style={[styles.startupHint, { color: palette.tabInactive }]}>
                {translate("hostForm.startup.description")}
              </Text>
            </View>

            {startupMode === "command" ? (
              <SettingsGroup>
                <PasteField
                  label={translate("hostForm.startup.modeCommand")}
                  value={startupCommand}
                  placeholder={translate("hostForm.startup.commandPlaceholder")}
                  onChangeText={setStartupCommand}
                />
              </SettingsGroup>
            ) : null}

            {startupMode === "snippet" ? (
              <SettingsGroup
                footer={
                  startupSnippetMissing
                    ? translate("hostForm.startup.missing")
                    : startupHasVariables
                      ? translate("hostForm.startup.varsHint")
                      : translate("hostForm.startup.snippetOnlyOnDesktop")
                }
              >
                <SettingsRow
                  icon="terminal-outline"
                  label={
                    selectedSnippet
                      ? selectedSnippet.label
                      : translate("hostForm.startup.selectPlaceholder")
                  }
                  tone={startupSnippetMissing ? "danger" : "default"}
                  onPress={() => setSnippetPickerOpen(true)}
                />
              </SettingsGroup>
            ) : null}
          </>
        ) : null}

        <Pressable
          disabled={!canSave}
          onPress={() => void handleSave()}
          style={[
            styles.saveButton,
            {
              backgroundColor: palette.accent,
              opacity: canSave ? 1 : 0.55,
            },
          ]}
        >
          <Text style={styles.saveText}>
            {saving
            ? translate("hostForm.saving")
            : hostId
              ? translate("hostForm.saveChanges")
              : translate("hostForm.addHost")}
          </Text>
        </Pressable>
      </ScrollView>
      <ListPickerModal
        visible={picker === "group"}
        title={translate("hostForm.fields.group")}
        // 경로를 통째로 적으면 work/aws/seoul 이 한 줄에 뭉친다 — 이름은 앞에, 어디에
        // 속하는지는 아랫줄에.
        items={groupPaths.map(path => {
          const cut = path.lastIndexOf("/");
          return {
            id: path,
            icon: "folder-outline",
            label: cut < 0 ? path : path.slice(cut + 1),
            detail: cut < 0 ? undefined : path.slice(0, cut),
          };
        })}
        selectedIds={groupName ? [groupName] : []}
        searchPlaceholder={translate("hostForm.group.search")}
        emptyText={translate("hostForm.group.empty")}
        noneLabel={translate("hostForm.group.none")}
        actionLabel={translate("groupActions.createTitle")}
        onAction={() => setGroupPromptOpen(true)}
        onSelect={id => {
          setGroupName(id ?? "");
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      >
        {/* 프롬프트는 이 시트 **안**에 있어야 한다 — 밖에 두면 iOS 가 두 번째 모달 띄우기를
            무시해서, 새 그룹 만들기를 눌러도 아무 일도 일어나지 않는다. */}
        <GroupNamePromptModal
          visible={groupPromptOpen}
          busy={groupBusy}
          title={translate("groupActions.createTitle")}
          hint={
            groupName
              ? translate("groupActions.createHint", { path: groupName })
              : translate("hostForm.group.createHintRoot")
          }
          submitLabel={translate("groupActions.create")}
          onClose={() => setGroupPromptOpen(false)}
          onSubmit={name => void handleCreateGroup(name)}
        />
      </ListPickerModal>
      <ListPickerModal
        visible={picker === "tailnet"}
        title={translate("hostForm.tailnet.label")}
        items={tailnets.map(item => ({ id: item.id, label: item.label }))}
        selectedIds={tailnetId ? [tailnetId] : []}
        searchPlaceholder={translate("hostForm.tailnet.search")}
        emptyText={translate("hostForm.tailnet.empty")}
        noneLabel={translate("hostForm.tailnet.none")}
        onSelect={id => {
          setTailnetId(id);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <ListPickerModal
        visible={picker === "jump"}
        multiple
        title={translate("hostForm.jump.header")}
        items={jumpCandidates.map(host => ({
          id: host.id,
          label: host.label,
          detail: `${host.username}@${host.hostname}:${host.port}`,
        }))}
        selectedIds={jumpHostIds}
        searchPlaceholder={translate("hostForm.jump.search")}
        emptyText={translate("hostForm.jump.empty")}
        onSelect={id => {
          if (!id) {
            return;
          }
          // 누르면 넣고 다시 누르면 뺀다. 순서는 넣은 차례 그대로가 곧 홉 순서다.
          setJumpHostIds(current =>
            current.includes(id)
              ? current.filter(item => item !== id)
              : current.length >= MAX_JUMP_HOSTS
                ? current
                : [...current, id],
          );
        }}
        onClose={() => setPicker(null)}
      />
      <StartupSnippetPickerModal
        visible={snippetPickerOpen}
        snippets={snippets}
        selectedSnippetId={startupSnippetId}
        onSelect={(snippet) => {
          setStartupSnippetId(snippet.id);
          setSnippetPickerOpen(false);
        }}
        onClose={() => setSnippetPickerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // 목록에 항목을 더하는 칸의 "+" — 키보드 완료로도 되지만, 눈에 보이는 버튼이 있어야
  // 무엇을 하면 들어가는지 알 수 있다.
  fieldAdd: {
    fontSize: 22,
    fontWeight: '600',
    paddingHorizontal: 6,
  },
  // 구획 이름이라 행 라벨(17)보다 크고 굵다 — 접혔을 때 여기가 무엇을 여는 곳인지 한눈에
  // 읽혀야 한다.
  advancedHeader: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 4,
  },
  advancedTitle: {
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  advancedSpacer: { flex: 1 },
  advancedSummary: {
    fontSize: 13,
    flexShrink: 1,
    textAlign: "right",
  },
  ec2ToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flex: 1,
  },
  ec2ToggleLabel: { fontSize: 15 },
  ec2Error: { marginTop: 12, fontSize: 13 },
  screen: {
    flex: 1,
  },
  content: {
    gap: 18,
  },
  // 그룹 머리글과 같은 결 — 카드 밖에서 조용히 구획만 나눈다(SettingsList 와 동일 규격).
  startupHint: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 4,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: -0.1,
    paddingHorizontal: 4,
  },
  authSection: {
    gap: 6,
  },
  segmentTrack: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: 14,
  },
  segment: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  segmentText: {
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  fieldRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  // 폭을 고정하면 값들이 같은 선에서 시작해 표처럼 읽힌다. 굵기는 그룹 리스트의 행 라벨과
  // 같은 17pt/400 이다 — 굵게 하면 라벨이 값보다 강조돼 화면이 라벨 목록처럼 보인다.
  fieldLabel: {
    width: 90,
    fontSize: 17,
    fontWeight: "400",
    letterSpacing: -0.2,
  },
  fieldInput: {
    flex: 1,
    fontSize: 17,
    letterSpacing: -0.2,
    paddingVertical: 0,
  },
  pasteField: {
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  pasteLabel: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  // 붙여넣기 영역은 배경과 테두리를 갖는다 — 라이트 모드에서 input 색은 카드와 거의 같아
  // 배경만으로는 여기가 입력 대상이라는 게 드러나지 않는다.
  pasteInput: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  errorText: {
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 4,
  },
  saveButton: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  saveText: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
    color: "#F8FBFF",
  },
});
