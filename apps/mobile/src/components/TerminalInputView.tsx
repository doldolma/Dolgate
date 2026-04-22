import React, { useImperativeHandle, useRef } from "react";
import {
  findNodeHandle,
  requireNativeComponent,
  type NativeSyntheticEvent,
  type StyleProp,
  UIManager,
  type ViewStyle,
} from "react-native";
import type { NativeTerminalInputEvent } from "../lib/terminal-input";

type NativeTerminalInputViewProps = {
  style?: StyleProp<ViewStyle>;
  focused?: boolean;
  focusToken?: number;
  clearToken?: number;
  softKeyboardEnabled?: boolean;
  onTerminalInput?: (
    event: NativeSyntheticEvent<NativeTerminalInputEvent>,
  ) => void;
};

export type TerminalInputViewHandle = {
  focus: () => void;
  blur: () => void;
};

const NativeTerminalInputViewComponent =
  requireNativeComponent<NativeTerminalInputViewProps>("TerminalInputView");

function dispatchTerminalInputCommand(
  nativeRef: React.RefObject<any>,
  commandName: "focus" | "blur",
) {
  const nativeHandle = findNodeHandle(nativeRef.current);
  if (!nativeHandle) {
    return;
  }

  const config = UIManager.getViewManagerConfig("TerminalInputView");
  const command = config?.Commands?.[commandName];
  if (command == null) {
    return;
  }

  UIManager.dispatchViewManagerCommand(nativeHandle, command, []);
}

export const TerminalInputView = React.forwardRef<
  TerminalInputViewHandle,
  NativeTerminalInputViewProps
>(function TerminalInputView(props, ref): React.JSX.Element {
  const nativeRef = useRef<any>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        dispatchTerminalInputCommand(nativeRef, "focus");
      },
      blur: () => {
        dispatchTerminalInputCommand(nativeRef, "blur");
      },
    }),
    [],
  );

  return <NativeTerminalInputViewComponent ref={nativeRef} {...props} />;
});
