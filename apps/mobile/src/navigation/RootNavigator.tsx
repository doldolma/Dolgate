import React from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import {
  createNativeStackNavigator,
} from "@react-navigation/native-stack";
import { useTheme } from "@react-navigation/native";
import Ionicons from "react-native-vector-icons/Ionicons";
import type { AuthState } from "@dolssh/shared-core";
import { AuthLandingScreen } from "../screens/AuthLandingScreen";
import { HomeScreen } from "../screens/HomeScreen";
import { SessionScreen } from "../screens/SessionScreen";
import { AuthSettingsScreen, SettingsScreen } from "../screens/SettingsScreen";
import { HostFormScreen } from "../screens/HostFormScreen";
import {
  VaultErrorScreen,
  VaultMigrateScreen,
  VaultSetupScreen,
  VaultUnlockScreen,
} from "../screens/VaultGateScreen";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

export type AuthStackParamList = {
  AuthLanding: undefined;
  AuthSettings: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Sessions: undefined;
  Settings: undefined;
};

// 메인 탭 위에 얹히는 루트 스택 — 호스트 폼(생성·수정)을 모달로 띄운다.
export type RootStackParamList = {
  Main: undefined;
  HostForm: { hostId?: string } | undefined;
};

interface RootNavigatorProps {
  authState: AuthState;
}

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
export const MAIN_TAB_INITIAL_ROUTE = "Home";
export const MAIN_TAB_BACK_BEHAVIOR = "fullHistory";

function HeaderTextButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  const palette = useMobilePalette();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={12}>
      <Text
        style={{
          color: palette.accent,
          fontSize: 17,
          fontWeight: "600",
          letterSpacing: -0.2,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function getTabIconName(
  routeName: keyof MainTabParamList,
  focused: boolean,
): string {
  switch (routeName) {
    case "Home":
      return focused ? "home" : "home-outline";
    case "Sessions":
      return focused ? "layers" : "layers-outline";
    case "Settings":
      return focused ? "settings" : "settings-outline";
    default:
      return focused ? "ellipse" : "ellipse-outline";
  }
}

function MainTabs(): React.JSX.Element {
  const palette = useMobilePalette();

  return (
    <Tab.Navigator
      initialRouteName={MAIN_TAB_INITIAL_ROUTE}
      backBehavior={MAIN_TAB_BACK_BEHAVIOR}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
          backgroundColor: palette.sessionToolbar,
          borderTopColor: palette.sessionToolbarBorder,
          borderTopWidth: 1,
          height: 58,
          paddingBottom: 4,
          paddingTop: 4,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarActiveTintColor: palette.sessionToolbarActive,
        tabBarInactiveTintColor: palette.sessionToolbarInactive,
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: "700",
          marginBottom: 0,
        },
        tabBarItemStyle: {
          paddingVertical: 0,
        },
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons
            name={getTabIconName(route.name as keyof MainTabParamList, focused)}
            color={color}
            size={size}
          />
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Sessions" component={SessionScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

function UnauthenticatedNavigator(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const { colors } = useTheme();

  return (
    <AuthStack.Navigator
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.card,
        },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }}
    >
      <AuthStack.Screen
        name="AuthLanding"
        component={AuthLandingScreen}
        options={{ headerShown: false }}
      />
      <AuthStack.Screen
        name="AuthSettings"
        component={AuthSettingsScreen}
        options={{ title: translate("nav.authSettings") }}
      />
    </AuthStack.Navigator>
  );
}

function isAppAccessible(authState: AuthState): boolean {
  return (
    (authState.status === "authenticated" ||
      authState.status === "offline-authenticated") &&
    Boolean(authState.session)
  );
}

export function RootNavigator({
  authState,
}: RootNavigatorProps): React.JSX.Element {
  const vault = useMobileAppStore((state) => state.vault);
  const vaultMigrationDeferred = useMobileAppStore(
    (state) => state.vaultMigrationDeferred,
  );
  const vaultE2eeServerSupport = useMobileAppStore(
    (state) => state.syncStatus.vaultE2eeServerSupport,
  );

  if (!isAppAccessible(authState)) {
    return <UnauthenticatedNavigator />;
  }

  // E2EE 볼트 게이트 — 동기화 암호 설정/입력 전에는 복호화된 데이터가 없으므로
  // 메인 탭 대신 해당 화면을 띄운다. unlocked 는 그대로 통과한다.
  if (vault.status === "setup-required") {
    return <VaultSetupScreen />;
  }
  if (vault.status === "locked") {
    return <VaultUnlockScreen />;
  }
  if (vault.status === "error") {
    return <VaultErrorScreen />;
  }
  // 기존(v1) 유저 전환 프롬프트 — 서버가 E2EE 를 지원하고, 온라인이며, 이번 실행에서
  // "나중에"를 누르지 않았을 때만. 오프라인 캐시 상태에서는 전환할 수 없으므로 건너뛴다.
  if (
    vault.status === "legacy" &&
    authState.status === "authenticated" &&
    (vault.migrationRequired ||
      (vaultE2eeServerSupport === "supported" && !vaultMigrationDeferred))
  ) {
    return <VaultMigrateScreen />;
  }

  return <AuthenticatedNavigator />;
}

function AuthenticatedNavigator(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const { colors } = useTheme();

  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      <RootStack.Screen name="Main" component={MainTabs} />
      <RootStack.Screen
        name="HostForm"
        component={HostFormScreen}
        options={({ navigation, route }) => ({
          presentation: "modal",
          headerShown: true,
          headerStyle: {
            backgroundColor: colors.card,
          },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          title: route.params?.hostId ? translate("nav.hostEdit") : translate("nav.hostAdd"),
          // 모달에는 back chevron 이 없다 — 이게 없으면 화면을 벗어나는 유일한 길이 아래로
          // 스와이프하는 제스처뿐이고, 그건 보이지 않는 경로다. 저장하지 않은 내용이 있으면
          // 화면 쪽 beforeRemove 가드가 확인을 받으므로 여기서는 그냥 나가기만 요청한다.
          headerLeft: () => (
            <HeaderTextButton
              label={translate("common.cancel")}
              onPress={() => navigation.goBack()}
            />
          ),
        })}
      />
    </RootStack.Navigator>
  );
}
