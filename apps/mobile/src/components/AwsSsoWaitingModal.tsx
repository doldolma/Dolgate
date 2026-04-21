import React from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { AwsSsoBrowserLoginPrompt } from "../lib/aws-session";
import { useMobilePalette } from "../theme";

interface AwsSsoWaitingModalProps {
  prompt: AwsSsoBrowserLoginPrompt | null;
  onCancel: () => void;
  onReopen: () => void;
}

export function AwsSsoWaitingModal({
  prompt,
  onCancel,
  onReopen,
}: AwsSsoWaitingModalProps): React.JSX.Element {
  const palette = useMobilePalette();

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      visible={Boolean(prompt)}
      onRequestClose={onCancel}
    >
      <SafeAreaView
        style={[
          styles.screen,
          {
            backgroundColor: palette.background,
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
          <Text style={[styles.title, { color: palette.text }]}>AWS 로그인</Text>
          <Text style={[styles.body, { color: palette.mutedText }]}>
            브라우저에서 AWS 로그인을 진행하고 있습니다. 로그인을 마친 뒤
            Dolgate로 돌아오면 자동으로 다시 확인합니다.
          </Text>
          {prompt ? (
            <View
              style={[
                styles.summaryBox,
                {
                  backgroundColor: palette.surfaceAlt,
                  borderColor: palette.border,
                },
              ]}
            >
              <Text style={[styles.summaryTitle, { color: palette.text }]}>
                {prompt.hostLabel}
              </Text>
              <Text style={[styles.summaryBody, { color: palette.mutedText }]}>
                {prompt.chainSummary}
              </Text>
            </View>
          ) : null}
          <View style={styles.spinnerRow}>
            <ActivityIndicator size="small" color={palette.accent} />
            <Text style={[styles.spinnerText, { color: palette.text }]}>
              로그인 완료를 확인하는 중
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              style={[
                styles.secondaryButton,
                {
                  borderColor: palette.border,
                  backgroundColor: palette.surfaceAlt,
                },
              ]}
            >
              <Text
                style={[styles.secondaryButtonText, { color: palette.mutedText }]}
              >
                취소
              </Text>
            </Pressable>
            <Pressable
              onPress={onReopen}
              style={[
                styles.primaryButton,
                {
                  backgroundColor: palette.accent,
                },
              ]}
            >
              <Text style={styles.primaryButtonText}>브라우저 다시 열기</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
    justifyContent: "center",
  },
  card: {
    borderWidth: 1,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 24,
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
  },
  summaryBox: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  summaryTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  summaryBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  spinnerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  spinnerText: {
    fontSize: 14,
    fontWeight: "600",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "700",
  },
  primaryButton: {
    flex: 1.4,
    minHeight: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
  },
});
