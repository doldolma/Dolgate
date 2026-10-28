import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "react-native-vector-icons/Ionicons";
import { useMobilePalette } from "../theme";

/** 키를 넣을 팀 프로필. */
export interface AwsKeyModalRequest {
  profileName: string;
  teamName: string;
}

interface AwsKeyModalProps {
  request: AwsKeyModalRequest | null;
  onCancel: () => void;
  /** 키를 저장한다(맞는지 확인한 뒤). 틀리면 던진다 — 창에 그 까닭을 남기고 저장하지 않는다. */
  onSave: (key: { accessKeyId: string; secretAccessKey: string }) => Promise<void>;
}

/**
 * 이 기기에 키가 없는 팀 정적 AWS 프로필에 키를 넣는 창 — 실패 화면의 '키 넣기'. 데스크톱 AwsKeyDialog(M3)와 같은
 * 자리·같은 말이다. 키는 이 기기에만 두고 동기화하지 않는다.
 */
export function AwsKeyModal({
  request,
  onCancel,
  onSave,
}: AwsKeyModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setAccessKeyId("");
    setSecretAccessKey("");
    setBusy(false);
    setErrorMessage(null);
  }, [request?.profileName]);

  const canSave =
    !busy && accessKeyId.trim().length > 0 && secretAccessKey.trim().length > 0;

  const save = async () => {
    if (!canSave) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      await onSave({ accessKeyId, secretAccessKey });
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("awsKey.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      transparent
      visible={request !== null}
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.overlay, { backgroundColor: palette.overlay }]}
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: palette.surfaceSolid,
              borderColor: palette.border,
            },
          ]}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[styles.title, { color: palette.text }]}>
              {translate("awsKey.dialogTitle", {
                profile: request?.profileName ?? "",
              })}
            </Text>
            <View style={styles.teamLine}>
              <Ionicons
                name="people-outline"
                size={13}
                color={palette.mutedText}
              />
              <Text style={[styles.teamText, { color: palette.mutedText }]}>
                {request?.teamName}
              </Text>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: palette.text }]}>
                Access Key
              </Text>
              <TextInput
                accessibilityLabel="Access Key"
                value={accessKeyId}
                onChangeText={setAccessKeyId}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                placeholder="AKIA..."
                placeholderTextColor={palette.mutedText}
                style={[
                  styles.input,
                  {
                    color: palette.text,
                    borderColor: palette.border,
                    backgroundColor: palette.input,
                  },
                ]}
              />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: palette.text }]}>
                Secret
              </Text>
              <TextInput
                accessibilityLabel="Secret"
                value={secretAccessKey}
                onChangeText={setSecretAccessKey}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                editable={!busy}
                placeholder="AWS secret access key"
                placeholderTextColor={palette.mutedText}
                style={[
                  styles.input,
                  {
                    color: palette.text,
                    borderColor: palette.border,
                    backgroundColor: palette.input,
                  },
                ]}
              />
            </View>

            {errorMessage ? (
              <Text style={[styles.errorText, { color: palette.danger }]}>
                {errorMessage}
              </Text>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={onCancel}
                disabled={busy}
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: palette.surfaceAlt,
                    borderColor: palette.border,
                  },
                ]}
              >
                <Text
                  style={[styles.secondaryButtonText, { color: palette.text }]}
                >
                  {translate("common.cancel")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSave }}
                onPress={() => void save()}
                disabled={!canSave}
                style={[
                  styles.primaryButton,
                  {
                    backgroundColor: palette.accent,
                    opacity: canSave || busy ? 1 : 0.5,
                  },
                ]}
              >
                {busy ? (
                  <ActivityIndicator color="#04111A" />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    {translate("awsKey.save")}
                  </Text>
                )}
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: "88%",
  },
  content: {
    padding: 22,
    gap: 14,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
  },
  teamLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: -6,
  },
  teamText: {
    fontSize: 13,
    fontWeight: "600",
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "700",
  },
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  errorText: {
    fontSize: 13,
    fontWeight: "700",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: "700",
  },
  primaryButton: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#04111A",
    fontSize: 15,
    fontWeight: "800",
  },
});
