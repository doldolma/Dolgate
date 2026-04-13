import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { formatRelativeTime } from "../lib/mobile";
import type { AuthStackParamList } from "../navigation/RootNavigator";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

type Props = NativeStackScreenProps<AuthStackParamList, "AuthLanding">;

export function AuthLandingScreen({ navigation }: Props): React.JSX.Element {
  const palette = useMobilePalette();
  const auth = useMobileAppStore((state) => state.auth);
  const settings = useMobileAppStore((state) => state.settings);
  const syncStatus = useMobileAppStore((state) => state.syncStatus);
  const startBrowserLogin = useMobileAppStore((state) => state.startBrowserLogin);

  const isAuthenticating = auth.status === "authenticating";

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: palette.background,
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
        <Text style={[styles.eyebrow, { color: palette.accent }]}>LOGIN</Text>
        <Text style={[styles.title, { color: palette.text }]}>
          로그인 후에만 동기화된 SSH 호스트와 세션을 사용할 수 있습니다.
        </Text>
        <Text style={[styles.subtitle, { color: palette.mutedText }]}>
          데스크톱과 동일하게 로그인 전에는 메인 워크스페이스를 숨깁니다.
          서버 주소를 확인한 뒤 브라우저 로그인을 진행하세요.
        </Text>

        <View
          style={[
            styles.infoCard,
            {
              backgroundColor: palette.surfaceAlt,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.infoLabel, { color: palette.mutedText }]}>
            현재 서버
          </Text>
          <Text style={[styles.infoValue, { color: palette.text }]}>
            {settings.serverUrl}
          </Text>
          <Text style={[styles.infoBody, { color: palette.mutedText }]}>
            인증 상태: {auth.status}
            {syncStatus.lastSuccessfulSyncAt
              ? ` • 최근 동기화 ${formatRelativeTime(syncStatus.lastSuccessfulSyncAt)}`
              : ""}
          </Text>
        </View>

        {auth.errorMessage ? (
          <View
            style={[
              styles.errorCard,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.danger,
              },
            ]}
          >
            <Text style={[styles.errorTitle, { color: palette.danger }]}>
              로그인 오류
            </Text>
            <Text style={[styles.errorBody, { color: palette.text }]}>
              {auth.errorMessage}
            </Text>
          </View>
        ) : null}

        {syncStatus.errorMessage ? (
          <View
            style={[
              styles.errorCard,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.warning,
              },
            ]}
          >
            <Text style={[styles.errorTitle, { color: palette.warning }]}>
              동기화 오류
            </Text>
            <Text style={[styles.errorBody, { color: palette.text }]}>
              {syncStatus.errorMessage}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            disabled={isAuthenticating}
            onPress={() => void startBrowserLogin()}
            style={[
              styles.primaryButton,
              {
                backgroundColor: isAuthenticating
                  ? palette.tabInactive
                  : palette.accent,
                opacity: isAuthenticating ? 0.7 : 1,
              },
            ]}
          >
            <Text style={styles.primaryText}>
              {isAuthenticating ? "브라우저 여는 중" : "로그인"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate("AuthSettings")}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>
              서버 설정
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 16,
  },
  heroCard: {
    borderWidth: 1,
    borderRadius: 24,
    padding: 18,
    gap: 12,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.1,
  },
  title: {
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 30,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  infoCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    gap: 4,
  },
  infoLabel: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: "700",
  },
  infoBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  errorCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    gap: 4,
  },
  errorTitle: {
    fontSize: 13,
    fontWeight: "800",
  },
  errorBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  primaryButton: {
    flex: 1,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryText: {
    color: "#04111A",
    fontSize: 15,
    fontWeight: "900",
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: {
    fontSize: 15,
    fontWeight: "800",
  },
});
