import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Ionicons from "react-native-vector-icons/Ionicons";
import type { AuthStackParamList } from "../navigation/RootNavigator";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

type Props = NativeStackScreenProps<AuthStackParamList, "AuthLanding">;

export function AuthLandingScreen({ navigation }: Props): React.JSX.Element {
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding({
    horizontal: 22,
    bottomOffset: 24,
    bottomMin: 40,
  });
  const auth = useMobileAppStore((state) => state.auth);
  const syncStatus = useMobileAppStore((state) => state.syncStatus);
  const startBrowserLogin = useMobileAppStore((state) => state.startBrowserLogin);
  const cancelBrowserLogin = useMobileAppStore(
    (state) => state.cancelBrowserLogin,
  );

  const isAuthenticating = auth.status === "authenticating";
  const inlineErrorMessage = auth.errorMessage ?? syncStatus.errorMessage;

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: palette.background,
          paddingHorizontal: screenPadding.paddingHorizontal,
          paddingTop: screenPadding.paddingTop,
          paddingBottom: screenPadding.paddingBottom,
        },
      ]}
    >
      <View
        style={[
          styles.heroCard,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="로그인 서버 설정 열기"
          hitSlop={12}
          onPress={() => navigation.navigate("AuthSettings")}
          style={[
            styles.settingsButton,
            {
              backgroundColor: palette.surfaceAlt,
              borderColor: palette.border,
            },
          ]}
        >
          <Ionicons name="settings-outline" size={18} color={palette.text} />
        </Pressable>

        <View style={styles.brandBlock}>
          <Text style={[styles.wordmark, { color: palette.text }]}>Dolgate</Text>
        </View>

        {inlineErrorMessage ? (
          <View
            style={[
              styles.errorCard,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.danger,
              },
            ]}
          >
            <Text style={[styles.errorBody, { color: palette.text }]}>
              {inlineErrorMessage}
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          disabled={isAuthenticating}
          onPress={() => void startBrowserLogin()}
          style={[
            styles.primaryButton,
            {
              backgroundColor: isAuthenticating
                ? palette.tabInactive
                : palette.accent,
              opacity: isAuthenticating ? 0.78 : 1,
            },
          ]}
        >
          <Text style={styles.primaryText}>
            {isAuthenticating ? "브라우저 여는 중" : "로그인"}
          </Text>
        </Pressable>

        {isAuthenticating ? (
          <Pressable
            accessibilityRole="button"
            onPress={cancelBrowserLogin}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>
              취소
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: "center",
  },
  heroCard: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    borderWidth: 1,
    borderRadius: 32,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 22,
    gap: 16,
    shadowColor: "#081320",
    shadowOffset: {
      width: 0,
      height: 14,
    },
    shadowOpacity: 0.08,
    shadowRadius: 30,
    elevation: 6,
    transform: [{ translateY: -56 }],
  },
  settingsButton: {
    position: "absolute",
    top: 18,
    right: 18,
    width: 40,
    height: 40,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  brandBlock: {
    minHeight: 110,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 0,
    paddingHorizontal: 18,
  },
  wordmark: {
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: -0.3,
    marginTop: -12,
  },
  errorCard: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  primaryButton: {
    minHeight: 62,
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: {
    color: "#F8FBFF",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: -0.2,
  },
  secondaryButton: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
});
