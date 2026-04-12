import React, { useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import DocumentPicker from "react-native-document-picker";
import type {
  HostSecretInput,
} from "@dolssh/shared-core";
import type { PendingCredentialPromptState } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

interface CredentialPromptModalProps {
  prompt: PendingCredentialPromptState | null;
  onSubmit: (value: HostSecretInput) => void;
  onCancel: () => void;
}

async function readPickedFileText(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error("개인키 파일을 읽지 못했습니다.");
  }
  return response.text();
}

export function CredentialPromptModal({
  prompt,
  onSubmit,
  onCancel,
}: CredentialPromptModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const [password, setPassword] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setPassword(prompt?.initialValue.password ?? "");
    setPrivateKeyPem(prompt?.initialValue.privateKeyPem ?? "");
    setPassphrase(prompt?.initialValue.passphrase ?? "");
    setErrorMessage(null);
  }, [prompt]);

  const handleImportPrivateKey = async () => {
    try {
      const result = await DocumentPicker.pickSingle({
        type: [DocumentPicker.types.plainText, DocumentPicker.types.allFiles],
        copyTo: "cachesDirectory",
      });
      const nextText = await readPickedFileText(result.fileCopyUri ?? result.uri);
      setPrivateKeyPem(nextText.trim());
      setErrorMessage(null);
    } catch (error) {
      if (DocumentPicker.isCancel(error)) {
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : "개인키 파일을 가져오지 못했습니다.";
      setErrorMessage(message);
      Alert.alert("가져오기 실패", message);
    }
  };

  const submit = () => {
    if (!prompt) {
      return;
    }

    if (prompt.authType === "password" && !password.trim()) {
      setErrorMessage("비밀번호를 입력해 주세요.");
      return;
    }

    if (prompt.authType === "privateKey" && !privateKeyPem.trim()) {
      setErrorMessage("개인키 PEM을 입력하거나 가져와 주세요.");
      return;
    }

    onSubmit({
      password: password.trim() || undefined,
      privateKeyPem: privateKeyPem.trim() || undefined,
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
      <View
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
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}
        >
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={[styles.title, { color: palette.text }]}>
              {prompt?.hostLabel} 자격 증명
            </Text>
            <Text style={[styles.body, { color: palette.mutedText }]}>
              {prompt?.message ?? "모바일에서 사용할 비밀 정보를 입력해 주세요."}
            </Text>

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
                    파일에서 가져오기
                  </Text>
                </Pressable>
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
                  암호화된 개인키는 네이티브 SSH 브리지 제약으로 일부 형식에서 실패할 수 있습니다.
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
                  취소
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
                <Text style={styles.primaryButtonText}>저장 후 연결</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
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
    minHeight: "58%",
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
