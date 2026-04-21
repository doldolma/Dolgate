import React from "react";
import {
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { useMobilePalette } from "../theme";

interface AwsSsoLoginModalProps {
  url: string | null;
  onCancel: () => void;
}

export function AwsSsoLoginModal({
  url,
  onCancel,
}: AwsSsoLoginModalProps): React.JSX.Element {
  const palette = useMobilePalette();

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      visible={Boolean(url)}
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
            styles.header,
            {
              borderBottomColor: palette.border,
              backgroundColor: palette.surface,
            },
          ]}
        >
          <Text style={[styles.title, { color: palette.text }]}>
            AWS 로그인
          </Text>
          <Pressable
            onPress={onCancel}
            style={[
              styles.closeButton,
              {
                borderColor: palette.border,
                backgroundColor: palette.surfaceAlt,
              },
            ]}
          >
            <Text style={[styles.closeButtonText, { color: palette.text }]}>
              닫기
            </Text>
          </Pressable>
        </View>
        {url ? (
          <WebView
            source={{ uri: url }}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            startInLoadingState
            style={styles.webview}
          />
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
  },
  closeButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  closeButtonText: {
    fontSize: 13,
    fontWeight: "700",
  },
  webview: {
    flex: 1,
  },
});
