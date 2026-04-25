import React from "react";
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

interface RootNavigatorProps {
  authState: AuthState;
}

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
export const MAIN_TAB_INITIAL_ROUTE = "Home";
export const MAIN_TAB_BACK_BEHAVIOR = "fullHistory";

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
        options={{ title: "서버 설정" }}
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
  if (!isAppAccessible(authState)) {
    return <UnauthenticatedNavigator />;
  }

  return <MainTabs />;
}
