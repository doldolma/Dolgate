import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Linking,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CredentialPromptModal } from "./components/CredentialPromptModal";
import { InteractiveAuthPromptModal } from "./components/InteractiveAuthPromptModal";
import { StartupVarsPromptModal } from "./components/StartupVarsPromptModal";
import { AwsSsoWaitingModal } from "./components/AwsSsoWaitingModal";
import { ServerKeyPromptModal } from "./components/ServerKeyPromptModal";
import { RdpCertificatePromptModal } from "./components/RdpCertificatePromptModal";
import { recordAwsSsoCallbackUrl } from "./lib/aws-session";
import { RootNavigator } from "./navigation/RootNavigator";
import { useMobileAppStore } from "./store/useMobileAppStore";
import { createNavigationTheme, getPalette, resolveAppTheme } from "./theme";
import { applyMobileLanguage, initMobileI18n } from "./i18n";

// 첫 렌더보다 먼저 언어를 정해 문구가 나중에 바뀌며 깜빡이지 않게 한다. 저장된 설정은
// persist 하이드레이트 뒤에 오므로 아래 useEffect 에서 맞춘다.
initMobileI18n();

export function AppRoot(): React.JSX.Element {
  const systemScheme = useColorScheme();
  const { t: translate } = useTranslation();
  const language = useMobileAppStore((state) => state.settings.language);
  const hydrated = useMobileAppStore((state) => state.hydrated);
  const authGateResolved = useMobileAppStore(
    (state) => state.authGateResolved,
  );
  const auth = useMobileAppStore((state) => state.auth);
  const remoteDesktopImmersive = useMobileAppStore(
    (state) => state.remoteDesktopImmersive,
  );
  const initializeApp = useMobileAppStore((state) => state.initializeApp);
  const handleAuthCallbackUrl = useMobileAppStore(
    (state) => state.handleAuthCallbackUrl,
  );
  const pendingServerKeyPrompt = useMobileAppStore(
    (state) => state.pendingServerKeyPrompt,
  );
  const pendingAwsSsoLogin = useMobileAppStore(
    (state) => state.pendingAwsSsoLogin,
  );
  const pendingCredentialRetry = useMobileAppStore(
    (state) => state.pendingCredentialRetry,
  );
  const submitCredentialRetry = useMobileAppStore(
    (state) => state.submitCredentialRetry,
  );
  const cancelCredentialRetry = useMobileAppStore(
    (state) => state.cancelCredentialRetry,
  );
  const pendingCredentialPrompt = useMobileAppStore(
    (state) => state.pendingCredentialPrompt,
  );
  const acceptServerKeyPrompt = useMobileAppStore(
    (state) => state.acceptServerKeyPrompt,
  );
  const rejectServerKeyPrompt = useMobileAppStore(
    (state) => state.rejectServerKeyPrompt,
  );
  const pendingRdpCertificatePrompt = useMobileAppStore(
    (state) => state.pendingRdpCertificatePrompt,
  );
  const acceptRdpCertificatePrompt = useMobileAppStore(
    (state) => state.acceptRdpCertificatePrompt,
  );
  const rejectRdpCertificatePrompt = useMobileAppStore(
    (state) => state.rejectRdpCertificatePrompt,
  );
  const pendingInteractiveAuthPrompt = useMobileAppStore(
    (state) => state.pendingInteractiveAuthPrompt,
  );
  const submitInteractiveAuthPrompt = useMobileAppStore(
    (state) => state.submitInteractiveAuthPrompt,
  );
  const cancelInteractiveAuthPrompt = useMobileAppStore(
    (state) => state.cancelInteractiveAuthPrompt,
  );
  const submitCredentialPrompt = useMobileAppStore(
    (state) => state.submitCredentialPrompt,
  );
  const cancelCredentialPrompt = useMobileAppStore(
    (state) => state.cancelCredentialPrompt,
  );
  const pendingStartupCommandPrompt = useMobileAppStore(
    (state) => state.pendingStartupCommandPrompt,
  );
  const submitStartupCommandPrompt = useMobileAppStore(
    (state) => state.submitStartupCommandPrompt,
  );
  const cancelStartupCommandPrompt = useMobileAppStore(
    (state) => state.cancelStartupCommandPrompt,
  );
  const cancelAwsSsoLogin = useMobileAppStore(
    (state) => state.cancelAwsSsoLogin,
  );
  const reopenAwsSsoLogin = useMobileAppStore(
    (state) => state.reopenAwsSsoLogin,
  );
  const settingsTheme = useMobileAppStore((state) => state.settings.theme);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    void initializeApp();
  }, [hydrated, initializeApp]);

  // 저장된 언어 설정을 반영한다(하이드레이트 전에는 기기 언어로 그려져 있다).
  useEffect(() => {
    applyMobileLanguage(language);
  }, [language]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const subscription = Linking.addEventListener("url", ({ url }) => {
      recordAwsSsoCallbackUrl(url);
      void handleAuthCallbackUrl(url);
    });

    void Linking.getInitialURL().then((url) => {
      if (url) {
        recordAwsSsoCallbackUrl(url);
        void handleAuthCallbackUrl(url);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [hydrated, handleAuthCallbackUrl]);

  const palette = getPalette(settingsTheme, systemScheme);
  const navigationTheme = createNavigationTheme(settingsTheme, systemScheme);
  const barStyle =
    resolveAppTheme(settingsTheme, systemScheme) === "light"
      ? "dark-content"
      : "light-content";

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider>
        {/* 원격 데스크톱 전체화면에서는 상태바까지 감춘다 — 가로에서 세로 픽셀이 귀하고,
            상태바만 남으면 "꽉 찬 화면" 이 아니라 어중간해 보인다. */}
        <StatusBar
          barStyle={barStyle}
          backgroundColor={palette.background}
          hidden={remoteDesktopImmersive}
        />
        <NavigationContainer theme={navigationTheme}>
          {!hydrated || !authGateResolved ? (
            <View
              style={[
                styles.loadingScreen,
                {
                  backgroundColor: palette.background,
                },
              ]}
            >
              <ActivityIndicator size="large" color={palette.accent} />
              <Text
                style={[
                  styles.loadingTitle,
                  {
                    color: palette.text,
                  },
                ]}
              >
                Dolgate
              </Text>
              <Text
                style={[
                  styles.loadingBody,
                  {
                    color: palette.mutedText,
                  },
                ]}
              >
                {translate("appRoot.preparing")}
              </Text>
            </View>
          ) : (
            <RootNavigator authState={auth} />
          )}
        </NavigationContainer>
        <ServerKeyPromptModal
          prompt={pendingServerKeyPrompt}
          onAccept={() => void acceptServerKeyPrompt()}
          onReject={() => void rejectServerKeyPrompt()}
        />
        <RdpCertificatePromptModal
          prompt={pendingRdpCertificatePrompt}
          onAccept={() => void acceptRdpCertificatePrompt()}
          onReject={() => void rejectRdpCertificatePrompt()}
        />
        <CredentialPromptModal
          prompt={pendingCredentialPrompt}
          onCancel={cancelCredentialPrompt}
          onSubmit={(value) => {
            void submitCredentialPrompt(value).catch((error: unknown) => {
              Alert.alert(
                translate("credentialPrompt.title", {
                  label: pendingCredentialPrompt?.hostLabel ?? "",
                }),
                error instanceof Error && error.message.trim()
                  ? error.message
                  : translate("credentialPrompt.defaultMessage"),
              );
            });
          }}
        />
        {/* 인증이 깨진 뒤의 재시도. 사전 프롬프트와 같은 창을 쓰되 사용자명 칸이 붙는다 —
            둘이 동시에 뜨는 일은 없다(하나는 붙기 전, 하나는 실패 후). */}
        <CredentialPromptModal
          prompt={pendingCredentialRetry}
          variant="retry"
          onCancel={cancelCredentialRetry}
          onSubmit={(value) => {
            // 모달이 이미 사용자명을 검사하므로 여기서 던지는 것은 사실상 방어선이다.
            // 그래도 삼키지는 않는다 — 조용히 아무 일도 안 일어나는 것이 제일 나쁘다.
            void submitCredentialRetry({
              ...value,
              username: value.username ?? "",
            }).catch((error: unknown) => {
              Alert.alert(
                translate("credentialRetry.title", {
                  label: pendingCredentialRetry?.hostLabel ?? "",
                }),
                error instanceof Error && error.message.trim()
                  ? error.message
                  : translate("credentialRetry.defaultMessage"),
              );
            });
          }}
        />
        <InteractiveAuthPromptModal
          challenge={pendingInteractiveAuthPrompt?.challenge ?? null}
          hopLabel={pendingInteractiveAuthPrompt?.hopLabel ?? null}
          onCancel={cancelInteractiveAuthPrompt}
          onSubmit={submitInteractiveAuthPrompt}
        />
        <StartupVarsPromptModal
          prompt={pendingStartupCommandPrompt}
          onCancel={cancelStartupCommandPrompt}
          onSubmit={submitStartupCommandPrompt}
        />
        <AwsSsoWaitingModal
          prompt={pendingAwsSsoLogin}
          onCancel={cancelAwsSsoLogin}
          onReopen={() => void reopenAwsSsoLogin()}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default AppRoot;

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 12,
  },
  loadingTitle: {
    fontSize: 24,
    fontWeight: "800",
  },
  loadingBody: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
