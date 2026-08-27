import React, { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import Ionicons from "react-native-vector-icons/Ionicons";

/**
 * 목록의 한 줄을 왼쪽으로 밀면 액션이 드러난다.
 *
 * **액션 판은 줄과 같은 자리·같은 크기에 깔린다.** 줄이 그 위로 미끄러지므로 "줄의 오른쪽 끝이
 * 액션으로 바뀌는" 것처럼 보인다 — iOS 메일부터 할 일 앱까지 쓰는 그 모양이다. 판을 줄 옆에
 * 따로 띄우면 둥근 덩어리 둘로 읽혀서 한 줄로 안 보인다.
 *
 * 줄 전체가 밀리므로 왼쪽 끝 글자는 화면 밖으로 나간다. 이건 이 방식의 성질이고 익숙한 앱들도
 * 같다 — 미는 동안에는 "내가 민 만큼 따라온다" 로 읽힌다.
 *
 * `react-native-gesture-handler` 의 `Swipeable` 을 쓴다. `ReanimatedSwipeable` 은
 * `react-native-reanimated` 를 요구하는데 이 앱에는 없다.
 */

/** 지금 열려 있는 줄. 다른 줄이 열리면 닫는다 — 열린 줄이 여럿이면 어느 것을 누르는지 모른다. */
let openRow: Swipeable | null = null;

/**
 * 열려 있는 줄을 닫는다.
 *
 * 표준 동작은 **열린 줄이 다른 조작 한 번에 닫히는 것**이다 — 목록을 스크롤하거나, 다른 화면에
 * 갔다 오거나, 빈 곳을 누르면 닫힌다. 그 조작들은 이 줄을 모르므로 화면 쪽에서 불러 준다.
 */
export function closeOpenSwipeableRow(): void {
  openRow?.close();
}

export interface SwipeableRowAction {
  key: string;
  label: string;
  icon: string;
  /** 판 배경색. 파괴적인 것만 빨강을 준다(화면에 빨강이 하나여야 눈에 먼저 들어온다). */
  background: string;
  onPress: () => void;
}

interface SwipeableRowProps {
  /** 오른쪽 끝에서부터 놓인다. 마지막 항목이 가장 바깥이다. */
  actions: SwipeableRowAction[];
  /** 액션 한 칸의 폭. 글자와 아이콘이 들어갈 만큼. */
  actionWidth?: number;
  /** 줄의 모서리. 액션 판이 같은 값을 써야 한 줄로 읽힌다. */
  borderRadius?: number;
  children: React.ReactNode;
}

export function SwipeableRow({
  actions,
  actionWidth = 74,
  borderRadius = 18,
  children,
}: SwipeableRowProps): React.ReactElement {
  const rowRef = useRef<Swipeable | null>(null);
  // 열려 있는 동안에는 줄 위에 투명한 덮개를 덮는다 — 아래를 보라.
  const [open, setOpen] = useState(false);

  const close = (): void => {
    rowRef.current?.close();
  };

  const renderActions = (): React.ReactElement => (
    <View style={[styles.tray, { borderRadius }]}>
      {actions.map(action => (
        <Pressable
          key={action.key}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={() => {
            // **먼저 닫고 실행한다.** 확인창이나 화면 전환이 열린 줄 위로 올라오면, 돌아왔을 때
            // 그 줄만 열린 채로 남는다.
            close();
            action.onPress();
          }}
          style={[styles.action, { width: actionWidth, backgroundColor: action.background }]}
        >
          <Ionicons name={action.icon} size={17} color="#FFFFFF" />
          <Text style={styles.actionLabel}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <Swipeable
      ref={row => {
        rowRef.current = row;
      }}
      renderRightActions={renderActions}
      // 손을 떼는 지점이 이만큼 지나면 열린 채로 둔다. 기본값(40)은 목록을 세로로 넘기다
      // 가로 성분이 조금만 섞여도 열려서 거슬린다.
      rightThreshold={actionWidth * 0.5}
      overshootRight={false}
      onSwipeableWillOpen={() => {
        if (openRow && openRow !== rowRef.current) {
          openRow.close();
        }
        openRow = rowRef.current;
        setOpen(true);
      }}
      onSwipeableClose={() => {
        if (openRow === rowRef.current) {
          openRow = null;
        }
        setOpen(false);
      }}
    >
      {children}
      {/* **열려 있을 때의 첫 탭은 닫기에만 쓰인다.**

          덮개가 없으면 열린 줄을 눌렀을 때 아래의 카드가 그 탭을 받는다 — 지우려고 열어 둔
          줄을 눌렀는데 그 호스트에 접속해 버린다. 표준 동작(iOS 메일 등)은 그 탭이 닫기만
          하는 것이다. 액션은 덮개 바깥(줄 오른쪽)에 있으므로 가려지지 않는다. */}
      {open ? (
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  // 줄과 같은 자리에 깔린다. Swipeable 이 이 판을 줄의 오른쪽에 붙여 주고, 줄이 그 위로 밀린다.
  tray: { flexDirection: "row", overflow: "hidden" },
  action: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  actionLabel: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },
});
