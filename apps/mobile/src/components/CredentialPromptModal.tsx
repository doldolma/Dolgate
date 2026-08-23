import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
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
import type {
  HostSecretInput,
} from "@dolssh/shared-core";
/**
 * 이 창이 띄우는 요청. 두 가지가 들어온다.
 *
 *  - `prompt` — 붙기 전에 저장된 비밀이 없어서 묻는 것. 사용자명은 호스트에 있으니 안 묻는다.
 *  - `retry`  — 인증이 깨진 뒤 다시 묻는 것. 틀린 것이 비밀인지 사용자명인지 알 수 없어서
 *               **사용자명까지** 받는다(데스크톱 CredentialRetryDialog 와 같은 자리).
 */
export interface CredentialModalRequest {
  hostLabel: string;
  authType: "password" | "privateKey" | "certificate";
  message?: string | null;
  initialValue?: HostSecretInput;
  initialUsername?: string;
}
import { useMobilePalette } from "../theme";
import { t } from "../i18n";
import {
  documentPickerTypes,
  pickLocalDocument,
} from "../lib/document-picker";

interface CredentialPromptModalProps {
  prompt: CredentialModalRequest | null;
  /** 창의 생김새는 같다. 제목·버튼 문구와, 비밀 칸을 채워 줄지 말지만 다르다. */
  variant?: "prompt" | "retry";
  onSubmit: (value: HostSecretInput & { username?: string }) => void;
  onCancel: () => void;
}

async function readPickedFileText(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(t("credentialPrompt.fileReadFailed"));
  }
  return response.text();
}

export function CredentialPromptModal({
  prompt,
  variant = "prompt",
  onSubmit,
  onCancel,
}: CredentialPromptModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const isRetry = variant === "retry";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [certificateText, setCertificateText] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setUsername(prompt?.initialUsername ?? "");
    // 재시도에서는 비밀 칸을 **비운 채로** 연다. 저장된 값을 채워 두면 방금 실패한 그 값을
    // 그대로 다시 보내기 쉽고, 무엇을 고쳐야 하는지도 가려진다.
    setPassword(isRetry ? "" : (prompt?.initialValue?.password ?? ""));
    setPrivateKeyPem(isRetry ? "" : (prompt?.initialValue?.privateKeyPem ?? ""));
    setCertificateText(
      isRetry ? "" : (prompt?.initialValue?.certificateText ?? ""),
    );
    setPassphrase(isRetry ? "" : (prompt?.initialValue?.passphrase ?? ""));
    setErrorMessage(null);
  }, [isRetry, prompt]);

  const handleImportPrivateKey = async () => {
    try {
      const result = await pickLocalDocument({
        type: [documentPickerTypes.plainText, documentPickerTypes.allFiles],
        fallbackName: "private-key",
      });
      if (!result) {
        return;
      }
      const nextText = await readPickedFileText(result.uri);
      setPrivateKeyPem(nextText.trim());
      setErrorMessage(null);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : translate("credentialPrompt.keyImportFailed");
      setErrorMessage(message);
      Alert.alert(translate("credentialPrompt.importFailedTitle"), message);
    }
  };

  const handleImportCertificate = async () => {
    try {
      const result = await pickLocalDocument({
        type: [documentPickerTypes.plainText, documentPickerTypes.allFiles],
        fallbackName: "certificate",
      });
      if (!result) {
        return;
      }
      const nextText = await readPickedFileText(result.uri);
      setCertificateText(nextText.trim());
      setErrorMessage(null);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : translate("credentialPrompt.certImportFailed");
      setErrorMessage(message);
      Alert.alert(translate("credentialPrompt.importFailedTitle"), message);
    }
  };

  const submit = () => {
    if (!prompt) {
      return;
    }

    if (!username.trim()) {
      setErrorMessage(translate("credentialRetry.usernameRequired"));
      return;
    }

    if (prompt.authType === "password" && !password.trim()) {
      setErrorMessage(translate("credentialPrompt.passwordRequired"));
      return;
    }

    if (
      (prompt.authType === "privateKey" || prompt.authType === "certificate") &&
      !privateKeyPem.trim()
    ) {
      setErrorMessage(translate("credentialPrompt.keyRequired"));
      return;
    }

    if (prompt.authType === "certificate" && !certificateText.trim()) {
      setErrorMessage(translate("credentialPrompt.certRequired"));
      return;
    }

    onSubmit({
      username: username.trim(),
      password: password.trim() || undefined,
      privateKeyPem: privateKeyPem.trim() || undefined,
      certificateText: certificateText.trim() || undefined,
      passphrase: passphrase.trim() || undefined,
    });
  };

  return (
    <Modal
      animationType="slide"
      transparent
      visible={Boolean(prompt)}
      onRequestClose={onCancel}
    >
      {/* 시트가 내용만큼만 높아지므로 키보드가 올라오면 가려진다 — 키보드만큼 밀어 올린다.
          예전에는 시트에 minHeight 58% 를 박아 화면 절반을 차지하게 해서 가리는 것을 피했는데,
          그래서 비밀번호 한 칸짜리 창에도 빈 공간이 화면 절반이었다. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[
          styles.overlay,
          {
            backgroundColor: palette.overlay,
          },
        ]}
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
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={[styles.title, { color: palette.text }]}>
              {translate(
                isRetry ? "credentialRetry.title" : "credentialPrompt.title",
                { label: prompt?.hostLabel ?? "" },
              )}
            </Text>
            <Text style={[styles.body, { color: palette.mutedText }]}>
              {prompt?.message ??
                translate(
                  isRetry
                    ? "credentialRetry.defaultMessage"
                    : "credentialPrompt.defaultMessage",
                )}
            </Text>

            {/* 사용자명은 **두 경우 모두** 받는다. 붙기 전 창에서 못 고치면, 사용자명이
                틀렸을 때 눈앞에 자격증명 창을 두고도 고칠 데가 없다. */}
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: palette.text }]}>
                {translate("credentialRetry.usernameLabel")}
              </Text>
              <TextInput
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="root"
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

            {prompt?.authType === "password" ? (
              <View style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { color: palette.text }]}>
                  Password
                </Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  placeholder="SSH password"
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
            ) : (
              <>
                <View style={styles.fieldGroup}>
                  <Text style={[styles.fieldLabel, { color: palette.text }]}>
                    Private key PEM
                  </Text>
                  <TextInput
                    value={privateKeyPem}
                    onChangeText={setPrivateKeyPem}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    textAlignVertical="top"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    placeholderTextColor={palette.mutedText}
                    style={[
                      styles.textArea,
                      {
                        color: palette.text,
                        borderColor: palette.border,
                        backgroundColor: palette.input,
                      },
                    ]}
                  />
                </View>
                <Pressable
                  onPress={() => void handleImportPrivateKey()}
                  style={[
                    styles.secondaryButton,
                    {
                      backgroundColor: palette.surfaceAlt,
                      borderColor: palette.border,
                    },
                  ]}
                >
                  <Text style={[styles.secondaryButtonText, { color: palette.text }]}>
                    {translate("credentialPrompt.importFromFile")}
                  </Text>
                </Pressable>
                {prompt?.authType === "certificate" ? (
                  <>
                    <View style={styles.fieldGroup}>
                      <Text style={[styles.fieldLabel, { color: palette.text }]}>
                        SSH certificate
                      </Text>
                      <TextInput
                        value={certificateText}
                        onChangeText={setCertificateText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline
                        textAlignVertical="top"
                        placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
                        placeholderTextColor={palette.mutedText}
                        style={[
                          styles.textArea,
                          {
                            color: palette.text,
                            borderColor: palette.border,
                            backgroundColor: palette.input,
                          },
                        ]}
                      />
                    </View>
                    <Pressable
                      onPress={() => void handleImportCertificate()}
                      style={[
                        styles.secondaryButton,
                        {
                          backgroundColor: palette.surfaceAlt,
                          borderColor: palette.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.secondaryButtonText,
                          { color: palette.text },
                        ]}
                      >
                        {translate("credentialPrompt.importCertFromFile")}
                      </Text>
                    </Pressable>
                  </>
                ) : null}
                <View style={styles.fieldGroup}>
                  <Text style={[styles.fieldLabel, { color: palette.text }]}>
                    Passphrase
                  </Text>
                  <TextInput
                    value={passphrase}
                    onChangeText={setPassphrase}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                    placeholder="optional"
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
                <Text style={[styles.caption, { color: palette.mutedText }]}>
                  {translate("credentialPrompt.passphraseHint")}
                </Text>
              </>
            )}

            {errorMessage ? (
              <Text style={[styles.errorText, { color: palette.danger }]}>
                {errorMessage}
              </Text>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                onPress={onCancel}
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: palette.surfaceAlt,
                    borderColor: palette.border,
                  },
                ]}
              >
                <Text style={[styles.secondaryButtonText, { color: palette.text }]}>
                  {translate("common.cancel")}
                </Text>
              </Pressable>
              <Pressable
                onPress={submit}
                style={[
                  styles.primaryButton,
                  {
                    backgroundColor: palette.accent,
                  },
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {translate(
                    isRetry
                      ? "credentialRetry.submit"
                      : "credentialPrompt.saveAndConnect",
                  )}
                </Text>
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
  body: {
    fontSize: 14,
    lineHeight: 20,
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
  textArea: {
    minHeight: 170,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: "Menlo",
  },
  caption: {
    fontSize: 12,
    lineHeight: 18,
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
