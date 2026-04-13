import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { useTheme } from "@react-navigation/native";
import Ionicons from "react-native-vector-icons/Ionicons";
import type { AuthState } from "@dolssh/shared-core";
import { AuthLandingScreen } from "../screens/AuthLandingScreen";
import { ConnectionsScreen } from "../screens/ConnectionsScreen";
import { HomeScreen } from "../screens/HomeScreen";
import { SessionScreen } from "../screens/SessionScreen";
import { SettingsScreen } from "../screens/SettingsScreen";

export type AuthStackParamList = {
  AuthLanding: undefined;
  AuthSettings: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Connections: undefined;
  Settings: undefined;
};

export type AuthenticatedStackParamList = {
  MainTabs: undefined;
  Session: {
    sessionId: string;
  };
};

export type RootStackParamList = AuthenticatedStackParamList;

export type SessionScreenProps = NativeStackScreenProps<
  AuthenticatedStackParamList,
  "Session"
>;

interface RootNavigatorProps {
  authState: AuthState;
}

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
const Stack = createNativeStackNavigator<AuthenticatedStackParamList>();

function getTabIconName(
  routeName: keyof MainTabParamList,
  focused: boolean,
): string {
  switch (routeName) {
    case "Home":
      return focused ? "home" : "home-outline";
    case "Connections":
      return focused ? "layers" : "layers-outline";
    case "Settings":
      return focused ? "settings" : "settings-outline";
    default:
      return focused ? "ellipse" : "ellipse-outline";
  }
}

function MainTabs(): React.JSX.Element {
  const { colors } = useTheme();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          height: 68,
          paddingBottom: 10,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.text,
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: "700",
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
      <Tab.Screen name="Connections" component={ConnectionsScreen} />
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
        component={SettingsScreen}
        options={{ title: "Settings" }}
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
  const { colors } = useTheme();

  if (!isAppAccessible(authState)) {
    return <UnauthenticatedNavigator />;
  }

  return (
    <Stack.Navigator>
      <Stack.Screen
        name="MainTabs"
        component={MainTabs}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="Session"
        component={SessionScreen}
        options={{
          title: "Session",
          headerStyle: {
            backgroundColor: colors.card,
          },
          headerTintColor: colors.text,
          headerShadowVisible: false,
        }}
      />
    </Stack.Navigator>
  );
}
