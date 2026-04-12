import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { PendingServerKeyPromptState } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

interface ServerKeyPromptModalProps {
  prompt: PendingServerKeyPromptState | null;
  onAccept: () => void;
  onReject: () => void;
}

export function ServerKeyPromptModal({
  prompt,
  onAccept,
  onReject,
}: ServerKeyPromptModalProps): React.JSX.Element {
  const palette = useMobilePalette();

  return (
    <Modal
      animationType="fade"
      transparent
      visible={Boolean(prompt)}
      onRequestClose={onReject}
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
            styles.card,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.title, { color: palette.text }]}>
            {prompt?.status === "mismatch"
              ? "호스트 키가 변경되었습니다"
              : "새 호스트 키를 확인해 주세요"}
          </Text>
          <Text style={[styles.body, { color: palette.mutedText }]}>
            {prompt?.hostLabel} 연결 전에 서버 공개키를 신뢰할지 결정해야 합니다.
          </Text>

          <View
            style={[
              styles.infoBox,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.label, { color: palette.mutedText }]}>
              대상
            </Text>
            <Text style={[styles.value, { color: palette.text }]}>
              {prompt ? `${prompt.info.host}:${prompt.info.port}` : ""}
            </Text>

            <Text style={[styles.label, { color: palette.mutedText }]}>
              알고리즘
            </Text>
            <Text style={[styles.value, { color: palette.text }]}>
              {prompt?.info.algorithm}
            </Text>

            <Text style={[styles.label, { color: palette.mutedText }]}>
              SHA256 fingerprint
            </Text>
            <Text style={[styles.monoValue, { color: palette.text }]}>
              {prompt?.info.fingerprintSha256}
            </Text>

            {prompt?.existing ? (
              <>
                <Text style={[styles.label, { color: palette.mutedText }]}>
                  기존 fingerprint
                </Text>
                <Text style={[styles.monoValue, { color: palette.warning }]}>
                  {prompt.existing.fingerprintSha256}
                </Text>
              </>
            ) : null}
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={onReject}
              style={[
                styles.secondaryButton,
                {
                  backgroundColor: palette.surfaceAlt,
                  borderColor: palette.border,
                },
              ]}
            >
              <Text style={[styles.buttonText, { color: palette.text }]}>
                취소
              </Text>
            </Pressable>
            <Pressable
              onPress={onAccept}
              style={[
                styles.primaryButton,
                {
                  backgroundColor: palette.accent,
                },
              ]}
            >
              <Text style={[styles.buttonText, styles.primaryButtonText]}>
                신뢰하고 계속
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  card: {
    borderWidth: 1,
    borderRadius: 22,
    padding: 20,
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  infoBox: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  value: {
    fontSize: 15,
    fontWeight: "600",
  },
  monoValue: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: "Menlo",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButton: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "800",
  },
  primaryButtonText: {
    color: "#04111A",
  },
});
