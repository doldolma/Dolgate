import {
  DarkTheme as NavigationDarkTheme,
  DefaultTheme as NavigationLightTheme,
  type Theme as NavigationTheme,
} from "@react-navigation/native";
import type { AppTheme } from "@dolssh/shared-core";
import {
  type ColorSchemeName,
  useColorScheme,
} from "react-native";
import { useMobileAppStore } from "./store/useMobileAppStore";

export interface MobilePalette {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  mutedText: string;
  accent: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
  input: string;
  tabInactive: string;
  overlay: string;
}

const darkPalette: MobilePalette = {
  background: "#0E1620",
  surface: "rgba(20, 28, 39, 0.96)",
  surfaceAlt: "rgba(28, 39, 53, 0.94)",
  border: "rgba(128, 149, 178, 0.2)",
  text: "#EEF4FB",
  mutedText: "#9DAFC3",
  accent: "#5F7FE0",
  accentSoft: "rgba(95, 127, 224, 0.18)",
  success: "#54C792",
  warning: "#F0BE67",
  danger: "#F17C87",
  input: "#131C27",
  tabInactive: "#78889E",
  overlay: "rgba(5, 9, 16, 0.8)",
};

const lightPalette: MobilePalette = {
  background: "#E8EEF5",
  surface: "rgba(255, 255, 255, 0.96)",
  surfaceAlt: "rgba(245, 248, 252, 0.94)",
  border: "rgba(84, 104, 132, 0.12)",
  text: "#182433",
  mutedText: "#66788F",
  accent: "#3457B3",
  accentSoft: "rgba(52, 87, 179, 0.1)",
  success: "#1E8A59",
  warning: "#B27A19",
  danger: "#B54856",
  input: "#FBFDFF",
  tabInactive: "#7A8B9F",
  overlay: "rgba(13, 18, 24, 0.18)",
};

export function resolveAppTheme(
  theme: AppTheme,
  systemScheme: ColorSchemeName,
): "light" | "dark" {
  if (theme === "system") {
    return systemScheme === "light" ? "light" : "dark";
  }
  return theme;
}

export function getPalette(
  theme: AppTheme,
  systemScheme: ColorSchemeName,
): MobilePalette {
  return resolveAppTheme(theme, systemScheme) === "light"
    ? lightPalette
    : darkPalette;
}

export function createNavigationTheme(
  theme: AppTheme,
  systemScheme: ColorSchemeName,
): NavigationTheme {
  const resolved = resolveAppTheme(theme, systemScheme);
  const palette = resolved === "light" ? lightPalette : darkPalette;
  const base =
    resolved === "light" ? NavigationLightTheme : NavigationDarkTheme;

  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.accent,
      background: palette.background,
      card: palette.surface,
      text: palette.text,
      border: palette.border,
      notification: palette.accent,
    },
  };
}

export function useMobilePalette(): MobilePalette {
  const theme = useMobileAppStore((state) => state.settings.theme);
  const systemScheme = useColorScheme();
  return getPalette(theme, systemScheme);
}
