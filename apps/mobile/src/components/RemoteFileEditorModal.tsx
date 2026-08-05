import React, { useCallback } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import Ionicons from "react-native-vector-icons/Ionicons";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

// 원격 파일 편집기. 데스크톱과 같은 규칙(크기 상한·바이너리 거부·충돌 감지·원자적 저장)을
// 엔진에서 처리하므로 이 화면은 상태를 보여주고 사용자의 결정을 받는 일만 한다.
//
// 문법 강조는 넣지 않는다 — 데스크톱도 하지 않고, 모바일에서 큰 파일에 얹으면 입력이 눈에
// 띄게 느려진다.
export function RemoteFileEditorModal(): React.JSX.Element | null {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  // 전체화면 모달이라 위를 덮어 주는 네비게이션 헤더가 없다 — 안전 영역을 직접 피해야 한다.
  const screenPadding = useScreenPadding({ topOffset: 8, includeSafeBottom: false });
  const editor = useMobileAppStore((state) => state.sftpEditor);
  const setContent = useMobileAppStore((state) => state.setSftpEditorContent);
  const save = useMobileAppStore((state) => state.saveSftpEditor);
  const reload = useMobileAppStore((state) => state.reloadSftpEditor);
  const close = useMobileAppStore((state) => state.closeSftpEditor);

  const isDirty = Boolean(editor && editor.content !== editor.originalContent);

  // 저장하지 않은 내용은 확인 없이 버리지 않는다 — 호스트 폼의 나가기 가드와 같은 규칙이다.
  const requestClose = useCallback(() => {
    if (!isDirty) {
      close();
      return;
    }
    Alert.alert(
      translate("sftpEditor.discardTitle"),
      translate("sftpEditor.discardBody"),
      [
        { text: translate("sftpEditor.keepEditing"), style: "cancel" },
        {
          text: translate("sftpEditor.discardConfirm"),
          style: "destructive",
          onPress: () => close(),
        },
      ],
    );
  }, [close, isDirty, translate]);

  // 충돌은 어느 쪽 변경을 버릴지 사용자만 정할 수 있다 — 양쪽 결과를 문구로 밝힌다.
  const resolveConflict = useCallback(() => {
    Alert.alert(
      translate("sftpEditor.conflictTitle"),
      translate("sftpEditor.conflictBody"),
      [
        { text: translate("common.cancel"), style: "cancel" },
        {
          text: translate("sftpEditor.reload"),
          onPress: () => void reload(),
        },
        {
          text: translate("sftpEditor.overwrite"),
          style: "destructive",
          onPress: () => void save({ force: true }),
        },
      ],
    );
  }, [reload, save, translate]);

  // 충돌은 저장을 누른 순간 드러난 것이니 그 자리에서 묻는다. 배너는 취소했을 때 다시
  // 열 수 있는 경로로만 남는다 — 그게 없으면 취소가 막다른 길이 된다.
  const handleSave = useCallback(async () => {
    const ok = await save();
    if (!ok && useMobileAppStore.getState().sftpEditor?.conflict) {
      resolveConflict();
    }
  }, [resolveConflict, save]);

  if (!editor) {
    return null;
  }

  const canSave = isDirty && !editor.isSaving && !editor.isLoading;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={requestClose}
    >
      <KeyboardAvoidingView
        style={[styles.screen, { backgroundColor: palette.background }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            styles.header,
            {
              backgroundColor: palette.surfaceSolid,
              borderBottomColor: palette.border,
              paddingTop: screenPadding.paddingTop,
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate("common.cancel")}
            hitSlop={12}
            onPress={requestClose}
          >
            <Ionicons name="close" size={24} color={palette.accent} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text
              numberOfLines={1}
              style={[styles.headerTitle, { color: palette.text }]}
            >
              {editor.fileName}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.headerPath, { color: palette.mutedText }]}
            >
              {editor.path}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate("sftpEditor.save")}
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            hitSlop={12}
            onPress={() => void handleSave()}
          >
            <Text
              style={[
                styles.headerAction,
                { color: canSave ? palette.accent : palette.tabInactive },
              ]}
            >
              {editor.isSaving
                ? translate("sftpEditor.saving")
                : translate("sftpEditor.save")}
            </Text>
          </Pressable>
        </View>

        {editor.errorMessage ? (
          <Pressable
            accessibilityRole={editor.conflict ? "button" : undefined}
            disabled={!editor.conflict}
            onPress={resolveConflict}
            style={[
              styles.banner,
              {
                backgroundColor: palette.surfaceSolid,
                borderBottomColor: palette.border,
              },
            ]}
          >
            {/* 충돌은 배너에서 무슨 일인지만 알리고, 무엇을 버릴지는 눌렀을 때 Alert 에서
                고르게 한다 — 긴 설명을 배너에 두면 두 곳에 같은 글이 생긴다. */}
            <Text
              style={[
                styles.bannerText,
                { color: editor.conflict ? palette.warning : palette.danger },
              ]}
            >
              {editor.conflict
                ? translate("sftpEditor.conflictTitle")
                : editor.errorMessage}
            </Text>
            {editor.conflict ? (
              <Text style={[styles.bannerAction, { color: palette.accent }]}>
                {translate("sftpEditor.conflictAction")}
              </Text>
            ) : null}
          </Pressable>
        ) : null}

        {editor.isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={palette.accent} />
            <Text style={[styles.loadingText, { color: palette.mutedText }]}>
              {translate("sftpEditor.loading")}
            </Text>
          </View>
        ) : (
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            <TextInput
              accessibilityLabel={translate("sftpEditor.title")}
              value={editor.content}
              onChangeText={setContent}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={[
                styles.editor,
                { color: palette.text, backgroundColor: palette.surfaceSolid },
              ]}
            />
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  headerPath: {
    fontSize: 12,
  },
  headerAction: {
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bannerText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  bannerAction: {
    fontSize: 13,
    fontWeight: "700",
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: {
    fontSize: 13,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 12,
  },
  // 코드·설정 파일이 대상이라 고정폭이 아니면 들여쓰기가 어긋나 보인다.
  editor: {
    minHeight: 320,
    borderRadius: 12,
    padding: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 13,
    lineHeight: 19,
    textAlignVertical: "top",
  },
});
