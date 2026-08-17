import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  EngineInteractiveAnswer,
  EngineInteractiveChallenge,
} from "../engine/types";
import { useMobilePalette } from "../theme";

interface InteractiveAuthPromptModalProps {
  /** 지금 묻는 라운드. 기다리는 것이 없으면 null. */
  challenge: EngineInteractiveChallenge | null;
  /**
   * 이 물음을 낸 서버. 코어는 주소만 주므로, 저장된 호스트의 이름은 호출부가 얹는다 —
   * 사용자는 주소보다 자기가 붙인 이름을 기억한다.
   */
  hopLabel?: string | null;
  onSubmit: (answer: EngineInteractiveAnswer) => void;
  onCancel: () => void;
}

/**
 * 대화형 인증 한 라운드를 묻는다 — 인증 코드, SSH 쪽 비밀번호, 서버가 로그인 앞에 세운 무엇이든.
 *
 * 모바일에는 이 시트가 없었다. 물어볼 자리가 없으니 OTP 를 요구하는 호스트에는 **아예 붙을 수가
 * 없었다**(코어가 "keyboard-interactive responder is not configured" 로 끝냈다).
 *
 * 칸은 코어가 보고한 대로 그린다. 어느 칸을 저장된 비밀번호로 답할 수 있고 어느 칸은 직접 넣어야
 * 하는지는 코어가 홉마다 내리는 판정이다 — 라벨을 보고 여기서 다시 고르면, `Password:` 라고 써
 * 놓고 2차 요소를 묻는 서버에 비밀번호를 그 칸으로 보내게 된다. 방식당 시도는 한 번뿐이라 그
 * 실수로 연결이 끝난다.
 */
export function InteractiveAuthPromptModal({
  challenge,
  hopLabel,
  onSubmit,
  onCancel,
}: InteractiveAuthPromptModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const [responses, setResponses] = useState<string[]>([]);
  const [storedPasswordPrompts, setStoredPasswordPrompts] = useState<boolean[]>([]);

  // 챌린지 ID 로 초기화한다 — 같은 연결의 다음 라운드는 빈 칸으로 시작해야 한다. 앞 라운드의
  // 입력이 남으면 비밀번호가 코드 칸의 답으로 들어간다.
  useEffect(() => {
    const count = challenge?.prompts.length ?? 0;
    setResponses(Array.from({ length: count }, () => ""));
    setStoredPasswordPrompts(Array.from({ length: count }, () => false));
  }, [challenge?.challengeId, challenge?.prompts.length]);

  const submit = () => {
    if (!challenge) {
      return;
    }
    const storedPasswordIndexes = storedPasswordPrompts
      .map((uses, index) => (uses ? index : -1))
      .filter(index => index >= 0);
    onSubmit({
      // 저장된 비밀번호로 채울 칸은 빈 값으로 보내고, 채우는 일은 코어가 한다. 비밀번호를
      // 앱으로 꺼냈다 다시 넣지 않는다.
      responses: responses.map((value, index) =>
        storedPasswordPrompts[index] ? "" : value,
      ),
      ...(storedPasswordIndexes.length ? { storedPasswordIndexes } : {}),
    });
  };

  return (
    <Modal
      animationType="slide"
      transparent
      visible={Boolean(challenge)}
      onRequestClose={onCancel}
    >
      <View style={[styles.overlay, { backgroundColor: palette.overlay }]}>
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: palette.surfaceSolid,
              borderColor: palette.border,
            },
          ]}
        >
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={[styles.sectionLabel, { color: palette.mutedText }]}>
              Additional Authentication
            </Text>
            <Text style={[styles.title, { color: palette.text }]}>
              {translate("authOverlay.extraAuthTitle")}
            </Text>

            {/* 누가 묻는지. 점프 체인에서는 베스천과 최종 대상이 똑같이 "Verification code:" 를
                내밀고, 엉뚱한 쪽 코드를 넣으면 한 번뿐인 시도가 그걸로 끝난다. */}
            {hopLabel ? (
              <View style={styles.hopRow}>
                <Text style={[styles.hopLabel, { color: palette.mutedText }]}>
                  {translate("authOverlay.hopLabel")}
                </Text>
                <Text style={[styles.hopValue, { color: palette.text }]}>
                  {hopLabel}
                </Text>
              </View>
            ) : null}

            {/* 서버가 쓴 문구를 그대로 보여준다. 다듬으면 "비밀번호 먼저, 그다음 코드" 같은
                순서가 지워진다. */}
            {challenge?.name ? (
              <Text style={[styles.body, { color: palette.mutedText }]}>
                {challenge.name}
              </Text>
            ) : null}
            {challenge?.instruction ? (
              <Text style={[styles.body, { color: palette.text }]}>
                {challenge.instruction}
              </Text>
            ) : null}

            {(challenge?.prompts ?? []).map((prompt, index) => {
              const usesStoredPassword = storedPasswordPrompts[index] === true;
              const offerStoredPassword =
                Boolean(challenge?.hasStoredPassword) && prompt.allowStoredPassword;
              return (
                <View
                  key={`${challenge?.challengeId ?? ""}:${index}`}
                  style={styles.fieldGroup}
                >
                  <Text style={[styles.fieldLabel, { color: palette.text }]}>
                    {prompt.label || `Prompt ${index + 1}`}
                  </Text>
                  <TextInput
                    value={responses[index] ?? ""}
                    onChangeText={value => {
                      setResponses(current =>
                        current.map((entry, position) =>
                          position === index ? value : entry,
                        ),
                      );
                    }}
                    editable={!usesStoredPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    // 가릴지는 코어의 프롬프트별 판정을 따른다(서버의 echo 가 아니다). 일회용
                    // 코드는 일부러 보여준다 — 다른 기기에서 옮겨 적는 여섯 자리를 가리면
                    // 막으려던 오타가 오히려 난다.
                    secureTextEntry={prompt.masked}
                    placeholder={
                      usesStoredPassword
                        ? translate("authOverlay.storedPasswordInUse")
                        : undefined
                    }
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
                  {offerStoredPassword ? (
                    <Pressable
                      onPress={() => {
                        setStoredPasswordPrompts(current =>
                          current.map((entry, position) =>
                            position === index ? !entry : entry,
                          ),
                        );
                      }}
                      style={[
                        styles.secondaryButton,
                        {
                          backgroundColor: palette.surfaceAlt,
                          borderColor: palette.border,
                        },
                      ]}
                    >
                      <Text
                        style={[styles.secondaryButtonText, { color: palette.text }]}
                      >
                        {usesStoredPassword
                          ? translate("authOverlay.storedPasswordCancel")
                          : translate("authOverlay.storedPasswordUse")}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}

            <Text style={[styles.caption, { color: palette.mutedText }]}>
              {translate("authOverlay.cancelHint")}
            </Text>

            <View style={styles.actions}>
              <Pressable
                onPress={onCancel}
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: palette.surfaceAlt,
                    borderColor: palette.border,
                  },
                ]}
              >
                <Text style={[styles.secondaryButtonText, { color: palette.text }]}>
                  {translate("common.cancel")}
                </Text>
              </Pressable>
              <Pressable
                onPress={submit}
                style={[styles.primaryButton, { backgroundColor: palette.accent }]}
              >
                <Text style={styles.primaryButtonText}>
                  {translate("authOverlay.sendResponse")}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: "88%",
  },
  content: {
    padding: 22,
    gap: 14,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
  },
  hopRow: {
    gap: 4,
  },
  hopLabel: {
    fontSize: 12,
    fontWeight: "700",
  },
  hopValue: {
    fontSize: 14,
    fontFamily: "Menlo",
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "700",
  },
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  caption: {
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: "700",
  },
  primaryButton: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#04111A",
    fontSize: 15,
    fontWeight: "800",
  },
});
