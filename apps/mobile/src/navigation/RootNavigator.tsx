import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { useTheme } from "@react-navigation/native";
import { ConnectionsScreen } from "../screens/ConnectionsScreen";
import { HomeScreen } from "../screens/HomeScreen";
import { SessionScreen } from "../screens/SessionScreen";
import { SettingsScreen } from "../screens/SettingsScreen";

export type MainTabParamList = {
  Home: undefined;
  Connections: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  MainTabs: undefined;
  Session: {
    sessionId: string;
  };
};

export type SessionScreenProps = NativeStackScreenProps<
  RootStackParamList,
  "Session"
>;

const Tab = createBottomTabNavigator<MainTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

function MainTabs(): React.JSX.Element {
  const { colors } = useTheme();

  return (
    <Tab.Navigator
      screenOptions={{
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
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Connections" component={ConnectionsScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export function RootNavigator(): React.JSX.Element {
  const { colors } = useTheme();

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
