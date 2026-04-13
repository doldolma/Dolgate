import { useSafeAreaInsets } from "react-native-safe-area-context";

interface ScreenPaddingOptions {
  horizontal?: number;
  includeSafeTop?: boolean;
  includeSafeBottom?: boolean;
  topOffset?: number;
  topMin?: number;
  bottomOffset?: number;
  bottomMin?: number;
}

export interface ScreenPadding {
  paddingHorizontal: number;
  paddingTop: number;
  paddingBottom: number;
}

export function useScreenPadding(
  options: ScreenPaddingOptions = {},
): ScreenPadding {
  const insets = useSafeAreaInsets();
  const {
    horizontal = 18,
    includeSafeTop = true,
    includeSafeBottom = true,
    topOffset = 10,
    topMin = 28,
    bottomOffset = 16,
    bottomMin = 24,
  } = options;

  return {
    paddingHorizontal: horizontal,
    paddingTop: includeSafeTop
      ? Math.max(insets.top + topOffset, topMin)
      : topOffset,
    paddingBottom: includeSafeBottom
      ? Math.max(insets.bottom + bottomOffset, bottomMin)
      : bottomOffset,
  };
}
