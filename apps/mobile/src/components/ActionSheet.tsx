import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "react-native-vector-icons/Ionicons";
import { useMobilePalette } from "../theme";

export interface ActionSheetItem {
  key: string;
  icon: string;
  label: string;
  danger?: boolean;
  /** 값이 있으면 그 줄을 비활성으로 그리고 이유를 아래에 적는다. */
  disabledReason?: string | null;
  onPress: () => void;
}

interface ActionSheetProps {
  visible: boolean;
  closeAccessibilityLabel: string;
  title?: string | null;
  subtitle?: string | null;
  items: ActionSheetItem[];
  onClose: () => void;
  /**
   * 시트가 실제로 사라진 뒤. **iOS 에서만 불린다**(RN Modal 의 onDismiss 가 iOS 전용).
   *
   * 시트를 닫자마자 다른 Modal 을 띄우면 iOS 는 "닫는 중에 띄우기" 가 되어 조용히 무시한다.
   * 시트에서 입력 모달로 넘어가는 흐름은 이 신호를 기다려야 한다.
   */
  onDismissed?: () => void;
}

// 아래에서 올라오는 액션 시트의 공용 껍데기.
//
// 호스트·그룹·추가 세 곳이 같은 제스처로 여는 시트라 생김새가 하나여야 한다. 예전에는 각자
// Modal·backdrop·줄 스타일을 복사해 갖고 있었는데, 그러면 한 곳만 고쳤을 때 같은 화면에서
// 시트마다 다르게 보인다.
export function ActionSheet({
  visible,
  closeAccessibilityLabel,
  title,
  subtitle,
  items,
  onClose,
  onDismissed,
}: ActionSheetProps): React.JSX.Element {
  const palette = useMobilePalette();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={onDismissed}
    >
      <Pressable
        style={[styles.backdrop, { backgroundColor: palette.overlay }]}
        accessibilityLabel={closeAccessibilityLabel}
        onPress={onClose}
      >
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: palette.surfaceSolid,
              borderColor: palette.border,
            },
          ]}
          onPress={(event) => event.stopPropagation()}
        >
          {title ? (
            <View style={styles.header}>
              <Text
                numberOfLines={1}
                style={[styles.title, { color: palette.text }]}
              >
                {title}
              </Text>
              {subtitle ? (
                <Text
                  numberOfLines={1}
                  style={[styles.subtitle, { color: palette.mutedText }]}
                >
                  {subtitle}
                </Text>
              ) : null}
            </View>
          ) : null}
          {items.map((item) => {
            const disabled = Boolean(item.disabledReason);
            const color = item.danger
              ? palette.danger
              : disabled
                ? palette.mutedText
                : palette.text;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                disabled={disabled}
                onPress={item.onPress}
                style={[
                  styles.actionRow,
                  { borderTopColor: palette.border },
                  disabled ? styles.actionRowDisabled : null,
                ]}
              >
                <Ionicons name={item.icon} size={20} color={color} />
                <View style={styles.actionCopy}>
                  <Text style={[styles.actionLabel, { color }]}>
                    {item.label}
                  </Text>
                  {item.disabledReason ? (
                    <Text
                      style={[styles.actionReason, { color: palette.mutedText }]}
                    >
                      {item.disabledReason}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", padding: 14 },
  sheet: {
    borderWidth: 1,
    borderRadius: 22,
    paddingBottom: 8,
    overflow: "hidden",
  },
  header: { paddingHorizontal: 18, paddingVertical: 14, gap: 3 },
  title: { fontSize: 16, fontWeight: "800" },
  subtitle: { fontSize: 12 },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  actionRowDisabled: { opacity: 0.55 },
  actionCopy: { flex: 1, gap: 2 },
  actionLabel: { fontSize: 15, fontWeight: "700" },
  actionReason: { fontSize: 11, lineHeight: 15 },
});
