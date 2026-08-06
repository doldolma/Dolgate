import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NavigationProp, RouteProp } from "@react-navigation/native";
import { isSshHostRecord } from "@dolssh/shared-core";
import type { AuthType, HostStartupCommand } from "@dolssh/shared-core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { SettingsGroup, SettingsRow } from "../components/SettingsList";
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

interface FieldRowProps {
  label: string;
  value: string;
  placeholder: string;
  onChangeText: (next: string) => void;
  keyboardType?: "default" | "number-pad";
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences";
}

// 한 줄 입력 행 — 라벨은 왼쪽에 남고 값은 그 오른쪽에 들어간다. placeholder 만으로 라벨을
// 대신하면 값을 채운 순간 무슨 칸이었는지 사라진다(이 폼의 가장 큰 문제였다).
function FieldRow({
  label,
  value,
  placeholder,
  onChangeText,
  keyboardType = "default",
  secureTextEntry = false,
  autoCapitalize = "none",
}: FieldRowProps): React.JSX.Element {
  const palette = useMobilePalette();
  return (
    <View style={styles.fieldRow}>
      <Text style={[styles.fieldLabel, { color: palette.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.tabInactive}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        style={[styles.fieldInput, { color: palette.text }]}
      />
    </View>
  );
}

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

interface SegmentedProps<T extends string> {
  options: Array<{ value: T; label: string }>;
  selected: T;
  onSelect: (next: T) => void;
}

// 인증 방식은 셋 중 하나를 고르는 단일 선택이라 하나의 트랙에 담는다. 예전에는 자격 증명
// 처리와 똑같이 생긴 알약 줄이 위아래로 붙어 있어, 성격이 다른 두 결정이 버튼 여섯 개짜리
// 한 덩어리로 읽혔다.
function Segmented<T extends string>({
  options,
  selected,
  onSelect,
}: SegmentedProps<T>): React.JSX.Element {
  const palette = useMobilePalette();
  return (
    <View style={[styles.segmentTrack, { backgroundColor: palette.surface }]}>
      {options.map((option) => {
        const active = option.value === selected;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(option.value)}
            style={[
              styles.segment,
              active ? { backgroundColor: palette.accentSoft } : null,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.segmentText,
                { color: active ? palette.accent : palette.mutedText },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// SSH 호스트 생성·수정 폼. 데스크톱 전용 고급 필드(jump host·환경변수·시작 명령 등)는
// 다루지 않는다 — 수정 시 스토어(saveHost)가 기존 값을 그대로 보존한다.
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

  const existing = useMemo(() => {
    if (!hostId) {
      return null;
    }
    const found = hosts.find((host) => host.id === hostId);
    return found && isSshHostRecord(found) ? found : null;
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
  const [groupName, setGroupName] = useState(existing?.groupName ?? "");
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
    groupName !== (existing?.groupName ?? "") ||
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
          <FieldRow
            label={translate("hostForm.fields.group")}
            value={groupName}
            placeholder={translate("hostForm.groupPlaceholder")}
            onChangeText={setGroupName}
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

        {validationMessage && (label || hostname || username) ? (
          <Text style={[styles.errorText, { color: palette.warning }]}>
            {validationMessage}
          </Text>
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
