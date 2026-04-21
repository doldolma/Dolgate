import React from "react";
import {
  type NativeSyntheticEvent,
  requireNativeComponent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { NativeTerminalInputEvent } from "../lib/terminal-input";

type NativeTerminalInputViewProps = {
  style?: StyleProp<ViewStyle>;
  focused?: boolean;
  focusToken?: number;
  clearToken?: number;
  onTerminalInput?: (
    event: NativeSyntheticEvent<NativeTerminalInputEvent>,
  ) => void;
};

const NativeTerminalInputViewComponent =
  requireNativeComponent<NativeTerminalInputViewProps>("TerminalInputView");

export function TerminalInputView(
  props: NativeTerminalInputViewProps,
): React.JSX.Element {
  return <NativeTerminalInputViewComponent {...props} />;
}
