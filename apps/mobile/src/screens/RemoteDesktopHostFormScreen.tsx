// RDP·VNC 호스트를 만들고 고친다.
//
// SSH 폼과 화면을 나눈 이유는 필드가 겹치지 않아서다 — 인증 방식·키·점프 대신 화질·보기
// 전용·공유가 온다. 한 화면에 넣으면 대부분 숨어 있는 칸이 되어, 어느 종류를 고치는 중인지
// 읽기 어려워진다.

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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
  FieldRow,
  HostKindField,
  type HostFormKind,
} from "../components/HostFormFields";
import { ListPickerModal } from "../components/ListPickerModal";
import { SettingsGroup, SettingsRow } from "../components/SettingsList";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

const DEFAULT_PORTS: Record<"rdp" | "vnc", number> = { rdp: 3389, vnc: 5900 };
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

  const [label, setLabel] = useState(existing?.label ?? "");
  const [hostname, setHostname] = useState(existing?.hostname ?? "");
  const [portDraft, setPortDraft] = useState(
    String(existing?.port ?? DEFAULT_PORTS[kind]),
  );
  const [groupName, setGroupName] = useState(existing?.groupName ?? "");
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [password, setPassword] = useState("");
  const [shared, setShared] = useState(vnc?.shared === true);
  const [viewOnly, setViewOnly] = useState(vnc?.viewOnly === true);
  const [imageQuality, setImageQuality] = useState<VncImageQuality>(
    vnc?.imageQuality ?? "balanced",
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
    return null;
  })();
  const canSave = !saving && !validationMessage;
  const selectedTailnet = tailnets.find(item => item.id === tailnetId) ?? null;

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
        tailnetId,
        // 비밀번호를 비워 두면 저장된 자격증명을 그대로 둔다 — 이름만 고치려고 들어왔다가
        // 비밀번호가 지워지면 다음 접속이 막힌다.
        credentialMode: password ? "replace" : "preserve",
        credentials: password
          ? { username, domain: kind === "rdp" ? domain : undefined, password }
          : null,
        ...(kind === "vnc"
          ? { shared, viewOnly, imageQuality }
          : {}),
      });
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
