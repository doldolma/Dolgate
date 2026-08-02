import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import type {
  HostSecretInput,
} from "@dolssh/shared-core";
import type { PendingCredentialPromptState } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";
import { t } from "../i18n";
import {
  documentPickerTypes,
  pickLocalDocument,
} from "../lib/document-picker";

interface CredentialPromptModalProps {
  prompt: PendingCredentialPromptState | null;
  onSubmit: (value: HostSecretInput) => void;
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
  onSubmit,
  onCancel,
}: CredentialPromptModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const [password, setPassword] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [certificateText, setCertificateText] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setPassword(prompt?.initialValue.password ?? "");
    setPrivateKeyPem(prompt?.initialValue.privateKeyPem ?? "");
    setCertificateText(prompt?.initialValue.certificateText ?? "");
    setPassphrase(prompt?.initialValue.passphrase ?? "");
    setErrorMessage(null);
  }, [prompt]);

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
              backgroundColor: palette.surfaceSolid,
              borderColor: palette.border,
            },
          ]}
        >
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={[styles.title, { color: palette.text }]}>
              {translate("credentialPrompt.title", { label: prompt?.hostLabel ?? "" })}
            </Text>
            <Text style={[styles.body, { color: palette.mutedText }]}>
              {prompt?.message ?? translate("credentialPrompt.defaultMessage")}
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
                <Text style={styles.primaryButtonText}>{translate("credentialPrompt.saveAndConnect")}</Text>
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
