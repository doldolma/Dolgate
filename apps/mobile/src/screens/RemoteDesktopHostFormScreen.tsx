// RDP·VNC 호스트를 만들고 고친다.
//
// SSH 폼과 화면을 나눈 이유는 필드가 겹치지 않아서다 — 인증 방식·키·점프 대신 화질·보기
// 전용·공유가 온다. 한 화면에 넣으면 대부분 숨어 있는 칸이 되어, 어느 종류를 고치는 중인지
// 읽기 어려워진다.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NavigationProp, RouteProp } from "@react-navigation/native";
import {
  collectGroupPaths,
  isRdpHostRecord,
  isVncHostRecord,
} from "@dolssh/shared-core";
import type { VncImageQuality } from "@dolssh/shared-core";
import {
  ChipField,
  FieldRow,
  HostKindField,
  type HostFormKind,
} from "../components/HostFormFields";
import Ionicons from "react-native-vector-icons/Ionicons";
import { ListPickerModal } from "../components/ListPickerModal";
import { SettingsGroup, SettingsRow } from "../components/SettingsList";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

const DEFAULT_PORTS: Record<"rdp" | "vnc", number> = { rdp: 3389, vnc: 5900 };
/** 색 깊이 선택지. 32가 기본이고 16은 느린 회선에서 쓴다. */
const COLOR_DEPTHS = [32, 16] as const;

const QUALITY_OPTIONS: VncImageQuality[] = ["fast", "balanced", "lossless"];

interface RemoteDesktopHostFormScreenProps {
  /** 만드는 중일 때의 종류. 고치는 중이면 null 이다(종류는 못 바꾼다). */
  createKind: HostFormKind | null;
  creatableKinds: ReadonlyArray<{ kind: HostFormKind; disabled: boolean }>;
  onCreateKindChange: (next: HostFormKind) => void;
}

export function RemoteDesktopHostFormScreen({
  createKind,
  creatableKinds,
  onCreateKindChange,
}: RemoteDesktopHostFormScreenProps): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding({ includeSafeTop: false });
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, "HostForm">>();
  const hostId = route.params?.hostId;
  const hosts = useMobileAppStore(state => state.hosts);
  const groups = useMobileAppStore(state => state.groups);
  const tailnets = useMobileAppStore(state => state.tailnets);
  const secretsByRef = useMobileAppStore(state => state.secretsByRef);
  const awsProfiles = useMobileAppStore(state => state.awsProfiles);
  const saveRemoteDesktopHost = useMobileAppStore(
    state => state.saveRemoteDesktopHost,
  );

  const existing = useMemo(() => {
    if (!hostId) {
      return null;
    }
    const found = hosts.find(host => host.id === hostId);
    return found && (isRdpHostRecord(found) || isVncHostRecord(found))
      ? found
      : null;
  }, [hostId, hosts]);

  const kind: "rdp" | "vnc" =
    existing?.kind ?? (createKind === "vnc" ? "vnc" : "rdp");
  const vnc = existing && isVncHostRecord(existing) ? existing : null;
  const rdp = existing && isRdpHostRecord(existing) ? existing : null;

  const [label, setLabel] = useState(existing?.label ?? "");
  const [hostname, setHostname] = useState(existing?.hostname ?? "");
  /**
   * 포트는 **손대기 전에는 종류를 따라간다.**
   *
   * state 초기값으로 굳히면 RDP 를 골랐다가 VNC 로 바꿀 때 3389 가 그대로 남는다 — 화면을
   * 다시 마운트하지 않으므로(같은 컴포넌트다) 초기값 계산이 다시 돌지 않는다. 그렇게 저장된
   * VNC 호스트는 연결이 거부된다.
   */
  const [portOverride, setPortOverride] = useState<string | null>(null);
  /**
   * RDP 고급 항목. **전부 동기화되는 호스트 값**이라 여기서 고치면 데스크톱에도 적용된다.
   *
   * 기본값은 데스크톱 연결 경로가 읽는 것과 같게 맞춘다 — 소리·클립보드는 없으면 켜짐,
   * 나머지는 없으면 꺼짐, 색 깊이는 없으면 32다.
   */
  const [adminSession, setAdminSession] = useState(rdp?.adminSession === true);
  const [colorDepth, setColorDepth] = useState<16 | 32>(
    rdp?.colorDepth === 16 ? 16 : 32,
  );
  const [audioEnabled, setAudioEnabled] = useState(rdp?.audioEnabled !== false);
  const [clipboardEnabled, setClipboardEnabled] = useState(
    rdp?.clipboardEnabled !== false,
  );
  // 태그는 SSH 폼과 같은 값이다 — 데스크톱에서 붙여 둔 것을 모바일이 보존만 하고 있었다.
  const [tags, setTags] = useState<string[]>(existing?.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 접어 둔 채로도 기본과 다른 것이 있는지는 보여야 한다 — 안 그러면 열어 봐야만 알 수 있다.
  const advancedSummary = [
    tags.length > 0
      ? translate("hostForm.tags.count", { count: tags.length })
      : null,
    adminSession ? translate("hostForm.rd.adminSession") : null,
    audioEnabled ? null : translate("hostForm.rd.audioOff"),
    clipboardEnabled ? null : translate("hostForm.rd.clipboardOff"),
    colorDepth === 16 ? translate("hostForm.rd.colorDepthValue.16") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const portDraft = portOverride ?? String(existing?.port ?? DEFAULT_PORTS[kind]);
  const setPortDraft = (next: string): void => setPortOverride(next);
  // 그룹을 보다가 들어왔으면 그 그룹에 만든다(SSH 폼과 같다) — 무시하면 최상위에 생기고,
  // 사용자는 폼에서 "그룹 없음" 을 보고 직접 다시 골라야 한다.
  const [groupName, setGroupName] = useState(
    existing?.groupName ?? route.params?.defaultGroupPath ?? "",
  );
  /**
   * 계정·도메인은 **시크릿에서 읽어 채운다.**
   *
   * RDP 는 계정이 호스트 레코드가 아니라 자격증명에 있다. 빈 칸으로 열어 두면 계정만 고치는
   * 길이 없고(비워 두면 저장이 무시한다), 비밀번호만 바꾸려던 사람이 저장된 계정을 지운다.
   *
   * 사용자가 손대기 전에는 저장된 값을 그대로 비춘다 — state 초기값으로 굳히면 시크릿이
   * 하이드레이트보다 먼저 열린 화면에서 영영 빈 칸으로 남는다.
   */
  const [accountDraft, setAccountDraft] = useState<{
    username: string;
    domain: string;
  } | null>(null);
  const storedSecret = existing?.secretRef
    ? secretsByRef[existing.secretRef]
    : undefined;
  const storedUsername = storedSecret?.username ?? "";
  const storedDomain = storedSecret?.domain ?? "";
  const username = accountDraft?.username ?? storedUsername;
  const domain = accountDraft?.domain ?? storedDomain;
  const setUsername = (next: string): void =>
    setAccountDraft({ username: next, domain });
  const setDomain = (next: string): void =>
    setAccountDraft({ username, domain: next });
  const [password, setPassword] = useState("");
  // 없거나 null 이면 공유(true), 화질은 무손실이다 — VncHostRecord 가 그렇게 규정한다.
  // `=== true` / `?? "balanced"` 로 읽으면 데스크톱에서 만든 호스트를 열자마자 값이 뒤집힌
  // 것으로 보이고, 저장하면 그 뒤집힌 값이 모든 기기로 퍼진다.
  const [shared, setShared] = useState(vnc?.shared !== false);
  const [viewOnly, setViewOnly] = useState(vnc?.viewOnly === true);
  const [imageQuality, setImageQuality] = useState<VncImageQuality>(
    vnc?.imageQuality ?? "lossless",
  );
  const [tailnetId, setTailnetId] = useState<string | null>(
    existing?.tailnetId ?? null,
  );
  const [picker, setPicker] = useState<"group" | "tailnet" | null>(null);
  const [saving, setSaving] = useState(false);

  const port = Number.parseInt(portDraft, 10);
  const validationMessage = (() => {
    if (!label.trim()) {
      return translate("hostForm.validation.name");
    }
    if (!hostname.trim()) {
      return translate("hostForm.validation.host");
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return translate("hostForm.validation.port");
    }
    // RDP 는 계정과 비밀번호가 **둘 다 시크릿에 있어야** 연결이 시작된다 — 연결 경로가
    // 그렇게 판정한다. 비운 채 저장하면 저장은 되는데 접속만 안 되는 호스트가 생기고(만들 때),
    // 고칠 때는 조용히 예전 값을 쓰거나 자격증명을 떼는 두 갈래뿐이다. 여기서 막는다.
    if (kind === "rdp" && !username.trim()) {
      return translate("hostForm.validation.username");
    }
    if (kind === "rdp" && !existing?.secretRef && !password) {
      return translate("hostForm.validation.password");
    }
    return null;
  })();
  const canSave = !saving && !validationMessage;
  const selectedTailnet = tailnets.find(item => item.id === tailnetId) ?? null;
  // 프로파일 이름은 id 로 지금 이름을 찾는다 — 이름은 사용자가 바꿀 수 있어서, 저장된 이름만
  // 믿으면 바꾼 뒤에는 없는 프로파일처럼 보인다. 못 찾으면 저장된 이름을 쓴다(접속 경로도 같은
  // 순서로 판단한다).
  const awsSsmSummary = useMemo(() => {
    const target = existing && isRdpHostRecord(existing) ? existing.awsSsm : null;
    if (!target) {
      return null;
    }
    const profileName =
      awsProfiles.find(
        profile => target.profileId && profile.id === target.profileId,
      )?.name ?? target.profileName;
    return [target.instanceId, target.region, profileName]
      .filter(Boolean)
      .join(" · ");
  }, [awsProfiles, existing]);

  const credentialsChanged =
    Boolean(password) ||
    (kind === "rdp" &&
      (username.trim() !== storedUsername || domain.trim() !== storedDomain));

  // 저장에 성공해 스스로 닫는 경우와 도중에 나가는 경우를 구분한다(SSH 폼과 같은 장치다).
  // 이 화면은 SSH 폼의 자식으로 그려지는데, 부모의 가드는 부모의 SSH 필드만 보므로 여기서
  // 고친 값은 확인 없이 사라졌다.
  const savedRef = useRef(false);
  const isDirty =
    label !== (existing?.label ?? "") ||
    hostname !== (existing?.hostname ?? "") ||
    portDraft !== String(existing?.port ?? DEFAULT_PORTS[kind]) ||
    groupName !== (existing?.groupName ?? "") ||
    tailnetId !== (existing?.tailnetId ?? null) ||
    credentialsChanged ||
    (kind === "vnc" &&
      (shared !== (vnc?.shared !== false) ||
        viewOnly !== (vnc?.viewOnly === true) ||
        imageQuality !== (vnc?.imageQuality ?? "lossless")));

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", event => {
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

  const handleSave = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await saveRemoteDesktopHost({
        hostId,
        kind,
        label,
        hostname,
        port,
        groupName: groupName.trim() ? groupName : null,
        tags,
        tailnetId,
        // 비밀번호를 비워 두면 저장된 자격증명을 그대로 둔다 — 이름만 고치려고 들어왔다가
        // 비밀번호가 지워지면 다음 접속이 막힌다. 다만 **계정을 고친 것도 교체다** —
        // 그러지 않으면 계정만 바꿔 저장했을 때 아무 말 없이 버려진다(비밀번호는 스토어가
        // 저장된 값을 이어 준다).
        credentialMode: credentialsChanged ? "replace" : "preserve",
        credentials: credentialsChanged
          ? {
              // VNC 에는 계정 칸이 없다. RDP 에서 치던 값을 그대로 실어 보내면 vnc-core 가
              // 인증 방식을 달리 고른다(계정이 있으면 ARD·TlsPlain).
              username: kind === "rdp" ? username.trim() : undefined,
              domain: kind === "rdp" ? domain.trim() : undefined,
              password: password || undefined,
            }
          : null,
        ...(kind === "vnc"
          ? { shared, viewOnly, imageQuality }
          : {
              adminSession,
              colorDepth,
              audioEnabled,
              clipboardEnabled,
              // 마이크·카메라는 **보내지 않는다.** 폰이 붙이지 않는 설정이라 폼에도 없고,
              // 저장부는 생략을 보존으로 읽으므로 데스크톱에서 켜 둔 값이 그대로 남는다
              // (`useAllMonitors` 도 같은 방식이다).
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
            paddingBottom: screenPadding.paddingBottom + 24,
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {createKind ? (
          <HostKindField
            kind={createKind}
            kinds={creatableKinds}
            onChange={onCreateKindChange}
            label={translate("hostForm.kindSection")}
            disabledHint={translate("hostForm.kindUnsupported")}
          />
        ) : null}

        <SettingsGroup
          header={translate(
            kind === "vnc" ? "hostForm.rd.vncSection" : "hostForm.rd.rdpSection",
          )}
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
            placeholder={String(DEFAULT_PORTS[kind])}
            onChangeText={setPortDraft}
            keyboardType="number-pad"
          />
          <SettingsRow
            icon="folder-outline"
            label={translate("hostForm.fields.group")}
            value={groupName || translate("hostForm.group.none")}
            chevron
            onPress={() => setPicker("group")}
          />
          {/* SSM 을 거치는지는 주소만 봐서는 알 수 없다 — 사설 IP 가 그대로 적혀 있어서 직접
              붙는 것처럼 보이는데 실제로는 포트 포워딩을 거친다(데스크톱 상세 패널과 같은 행).
              AWS 가져오기가 만든 값이라 기기에서 고칠 것이 아니므로 읽기 전용으로 둔다. */}
          {awsSsmSummary ? (
            <SettingsRow
              icon="cloud-outline"
              label={translate("hostForm.rd.awsSsm")}
              value={awsSsmSummary}
            />
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          header={translate("hostForm.credentialSection")}
          footer={translate(
            existing?.secretRef
              ? "hostForm.rd.credentialKeepHint"
              : "hostForm.syncHint",
          )}
        >
          {kind === "rdp" ? (
            <FieldRow
              label={translate("hostForm.fields.username")}
              value={username}
              placeholder={translate("hostForm.usernamePlaceholder")}
              onChangeText={setUsername}
            />
          ) : null}
          {kind === "rdp" ? (
            <FieldRow
              label={translate("hostForm.rd.domain")}
              value={domain}
              placeholder={translate("hostForm.rd.domainPlaceholder")}
              onChangeText={setDomain}
            />
          ) : null}
          <FieldRow
            label={translate("hostForm.fields.password")}
            value={password}
            placeholder={translate(
              existing?.secretRef
                ? "hostForm.rd.passwordKeepPlaceholder"
                : "hostForm.passwordPlaceholder",
            )}
            onChangeText={setPassword}
            secureTextEntry
          />
        </SettingsGroup>

        {kind === "vnc" ? (
          <SettingsGroup
            header={translate("hostForm.rd.vncOptions")}
            footer={translate("hostForm.rd.vncOptionsHint")}
          >
            <SettingsRow
              icon="eye-outline"
              label={translate("hostForm.rd.viewOnly")}
              toggle={{ value: viewOnly, onValueChange: setViewOnly }}
            />
            <SettingsRow
              icon="people-outline"
              label={translate("hostForm.rd.shared")}
              toggle={{ value: shared, onValueChange: setShared }}
            />
            {QUALITY_OPTIONS.map(option => (
              <SettingsRow
                key={option}
                label={translate(`hostForm.rd.quality.${option}`)}
                check={imageQuality === option}
                onPress={() => setImageQuality(option)}
              />
            ))}
          </SettingsGroup>
        ) : null}

        {kind === "rdp" ? (
          <>
            {/* 고급 — 평소에는 접어 둔다. SSH 폼과 같은 모양이다(HostFormScreen). 대부분의
                사람이 쓰는 것(이름·주소·계정·비밀번호)이 안 쓰는 항목들 사이에 묻히면 안 된다. */}
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
                </SettingsGroup>

                <SettingsGroup footer={translate("hostForm.rd.sessionHint")}>
                  <SettingsRow
                    icon="shield-outline"
                    label={translate("hostForm.rd.adminSession")}
                    toggle={{ value: adminSession, onValueChange: setAdminSession }}
                  />
                  <SettingsRow
                    icon="volume-medium-outline"
                    label={translate("hostForm.rd.audio")}
                    toggle={{ value: audioEnabled, onValueChange: setAudioEnabled }}
                  />
                  <SettingsRow
                    icon="clipboard-outline"
                    label={translate("hostForm.rd.clipboard")}
                    toggle={{
                      value: clipboardEnabled,
                      onValueChange: setClipboardEnabled,
                    }}
                  />
                </SettingsGroup>

                {/* 고르는 방식은 같은 화면의 VNC 화질과 같게 둔다 — 값이 둘뿐이라도 한 화면에서
                    고르는 방법이 두 가지면 어느 것이 지금 값인지 읽는 규칙이 달라진다. */}
                <SettingsGroup header={translate("hostForm.rd.colorDepth")}>
                  {COLOR_DEPTHS.map(option => (
                    <SettingsRow
                      key={option}
                      label={translate(`hostForm.rd.colorDepthValue.${option}`)}
                      check={colorDepth === option}
                      onPress={() => setColorDepth(option)}
                    />
                  ))}
                </SettingsGroup>
              </>
            ) : null}
          </>
        ) : null}

        <SettingsGroup footer={translate("hostForm.tailnet.hint")}>
          <SettingsRow
            icon="globe-outline"
            label={translate("hostForm.tailnet.label")}
            value={selectedTailnet?.label ?? translate("hostForm.tailnet.none")}
            chevron
            onPress={() => setPicker("tailnet")}
          />
        </SettingsGroup>

        {validationMessage && (label || hostname) ? (
          <Text style={[styles.error, { color: palette.danger }]}>
            {validationMessage}
          </Text>
        ) : null}

        <Pressable
          disabled={!canSave}
          onPress={() => void handleSave()}
          style={[
            styles.saveButton,
            { backgroundColor: palette.accent, opacity: canSave ? 1 : 0.55 },
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
        items={collectGroupPaths(groups, hosts).map(path => ({
          id: path,
          label: path,
        }))}
        selectedIds={groupName ? [groupName] : []}
        searchPlaceholder={translate("hostForm.group.search")}
        emptyText={translate("hostForm.group.empty")}
        noneLabel={translate("hostForm.group.none")}
        onSelect={id => {
          setGroupName(id ?? "");
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // SSH 폼(HostFormScreen)의 고급 머리글과 같은 값이다 — 두 폼이 다르게 보이면 같은 구획인
  // 줄을 모른다.
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
  screen: { flex: 1 },
  content: { gap: 16, paddingTop: 12 },
  error: { fontSize: 13, paddingHorizontal: 4 },
  saveButton: {
    borderRadius: 18,
    paddingVertical: 15,
    alignItems: "center",
  },
  saveText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});
