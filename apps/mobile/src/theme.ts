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
  background: "#081018",
  surface: "#0F1A24",
  surfaceAlt: "#152432",
  border: "#233849",
  text: "#F3F8FC",
  mutedText: "#93A8BB",
  accent: "#5ED0FF",
  accentSoft: "#15364A",
  success: "#54D29D",
  warning: "#F0BC62",
  danger: "#FF7C7C",
  input: "#0C1620",
  tabInactive: "#6F869A",
  overlay: "rgba(3, 8, 15, 0.82)",
};

const lightPalette: MobilePalette = {
  background: "#F3F6FA",
  surface: "#FFFFFF",
  surfaceAlt: "#EEF3F8",
  border: "#D7E2EC",
  text: "#0E1721",
  mutedText: "#5F7284",
  accent: "#0077B8",
  accentSoft: "#DDEFFA",
  success: "#1E8C5A",
  warning: "#B57712",
  danger: "#B63939",
  input: "#F7FAFD",
  tabInactive: "#6B7A89",
  overlay: "rgba(13, 18, 24, 0.2)",
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
