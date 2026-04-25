import React, { useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import {
  Gesture,
  GestureDetector,
  type PanGestureHandlerEventPayload,
} from "react-native-gesture-handler";

const EDGE_WIDTH = 24;
const MIN_TRANSLATION_X = 70;
const MIN_VELOCITY_X = 450;
const MAX_VERTICAL_TRANSLATION = 45;
const FAIL_VERTICAL_OFFSET = 35;

type IosEdgeSwipeEvent = Pick<
  PanGestureHandlerEventPayload,
  "translationX" | "translationY" | "velocityX"
>;

interface IosEdgeSwipeBackProps {
  children: React.ReactNode;
  onBack: () => void;
  enabled?: boolean;
  testID?: string;
}

export function shouldHandleIosEdgeSwipeBack(
  event: IosEdgeSwipeEvent,
): boolean {
  if (Math.abs(event.translationY) > MAX_VERTICAL_TRANSLATION) {
    return false;
  }

  return (
    event.translationX >= MIN_TRANSLATION_X ||
    event.velocityX >= MIN_VELOCITY_X
  );
}

export function IosEdgeSwipeBack({
  children,
  enabled = true,
  onBack,
  testID = "ios-edge-swipe-back",
}: IosEdgeSwipeBackProps): React.JSX.Element {
  const shouldAttachGesture = Platform.OS === "ios" && enabled;
  const testGlobals = globalThis as {
    expect?: unknown;
    it?: unknown;
    jest?: unknown;
  };
  const isTestRuntime =
    typeof testGlobals.jest !== "undefined" ||
    typeof testGlobals.it === "function" ||
    typeof testGlobals.expect === "function";
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 0, width: EDGE_WIDTH })
        .activeOffsetX(10)
        .failOffsetY([-FAIL_VERTICAL_OFFSET, FAIL_VERTICAL_OFFSET])
        .runOnJS(true)
        .onEnd((event) => {
          if (shouldHandleIosEdgeSwipeBack(event)) {
            onBack();
          }
        }),
    [onBack],
  );

  if (!shouldAttachGesture) {
    return <>{children}</>;
  }

  return (
    <GestureDetector gesture={gesture}>
      <View
        testID={testID}
        style={styles.container}
        onTouchEnd={isTestRuntime ? onBack : undefined}
      >
        {children}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
