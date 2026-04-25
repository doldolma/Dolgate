import React, { useEffect } from "react";
import {
  ActivityIndicator,
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
import { AwsSsoWaitingModal } from "./components/AwsSsoWaitingModal";
import { ServerKeyPromptModal } from "./components/ServerKeyPromptModal";
import { recordAwsSsoCallbackUrl } from "./lib/aws-session";
import { RootNavigator } from "./navigation/RootNavigator";
import { useMobileAppStore } from "./store/useMobileAppStore";
import { createNavigationTheme, getPalette, resolveAppTheme } from "./theme";

export function AppRoot(): React.JSX.Element {
  const systemScheme = useColorScheme();
  const hydrated = useMobileAppStore((state) => state.hydrated);
  const authGateResolved = useMobileAppStore(
    (state) => state.authGateResolved,
  );
  const auth = useMobileAppStore((state) => state.auth);
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
  const pendingCredentialPrompt = useMobileAppStore(
    (state) => state.pendingCredentialPrompt,
  );
  const acceptServerKeyPrompt = useMobileAppStore(
    (state) => state.acceptServerKeyPrompt,
  );
  const rejectServerKeyPrompt = useMobileAppStore(
    (state) => state.rejectServerKeyPrompt,
  );
  const submitCredentialPrompt = useMobileAppStore(
    (state) => state.submitCredentialPrompt,
  );
  const cancelCredentialPrompt = useMobileAppStore(
    (state) => state.cancelCredentialPrompt,
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
        <StatusBar barStyle={barStyle} backgroundColor={palette.background} />
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
                앱을 준비하고 있습니다.
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
        <CredentialPromptModal
          prompt={pendingCredentialPrompt}
          onCancel={cancelCredentialPrompt}
          onSubmit={(value) => void submitCredentialPrompt(value)}
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
