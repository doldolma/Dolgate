import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMobilePalette } from "../theme";

interface GroupNamePromptModalProps {
  visible: boolean;
  title: string;
  /** 열릴 때 채워 둘 값. 이름 변경이면 지금 이름, 새로 만들기면 빈 문자열. */
  initialValue?: string;
  /** 어느 경로 아래에 만들어지는지 같은 보조 설명. 없으면 그리지 않는다. */
  hint?: string | null;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

// 이름 하나를 받는 모달.
//
// `Alert.prompt` 를 쓸 수 없어서 만들었다 — **iOS 전용이라 안드로이드에는 텍스트 입력이 있는
// Alert 이 없다.** 그룹 만들기와 이름 변경이 같은 것을 쓴다(둘 다 이름 하나를 받는다).
export function GroupNamePromptModal({
  visible,
  title,
  initialValue = "",
  hint,
  submitLabel,
  busy = false,
  onSubmit,
  onClose,
}: GroupNamePromptModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const [value, setValue] = useState(initialValue);

  // 열릴 때마다 초기값으로 되돌린다. 남겨 두면 다른 그룹을 눌렀는데 앞의 이름이 남는다.
  useEffect(() => {
    if (visible) {
      setValue(initialValue);
    }
  }, [initialValue, visible]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.backdrop, { backgroundColor: palette.overlay }]}
        onPress={onClose}
      >
        <Pressable
          style={[
            styles.card,
            {
              backgroundColor: palette.surfaceSolid,
              borderColor: palette.border,
            },
          ]}
          onPress={(event) => event.stopPropagation()}
        >
          <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (canSubmit) {
                onSubmit(trimmed);
              }
            }}
            accessibilityLabel={translate("groupActions.namePlaceholder")}
            placeholder={translate("groupActions.namePlaceholder")}
            placeholderTextColor={palette.mutedText}
            style={[
              styles.input,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.input,
              },
            ]}
          />
          {hint ? (
            <Text style={[styles.hint, { color: palette.mutedText }]}>
              {hint}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={styles.action}
            >
              <Text style={[styles.actionLabel, { color: palette.mutedText }]}>
                {translate("common.cancel")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!canSubmit}
              onPress={() => onSubmit(trimmed)}
              style={styles.action}
            >
              <Text
                style={[
                  styles.actionLabel,
                  { color: canSubmit ? palette.accent : palette.mutedText },
                ]}
              >
                {submitLabel}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", padding: 24 },
  card: { borderWidth: 1, borderRadius: 18, padding: 18, gap: 12 },
  title: { fontSize: 16, fontWeight: "800" },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  hint: { fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  action: { paddingHorizontal: 12, paddingVertical: 8 },
  actionLabel: { fontSize: 15, fontWeight: "700" },
});
