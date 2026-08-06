// startup command 로 지정한 스니펫의 {{변수}} 값을 접속 중에 받는다.
//
// 셸이 이미 열린 뒤에 뜬다 — 명령은 프롬프트가 감지된 뒤에 타이핑되므로 값이 늦게 들어와도
// 순서가 어긋나지 않는다. 취소하면 명령 없이 그대로 쓴다(접속을 되돌리지 않는다).

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { PendingStartupCommandPromptState } from '../store/useMobileAppStore';
import { useMobilePalette } from '../theme';

interface StartupVarsPromptModalProps {
  prompt: PendingStartupCommandPromptState | null;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

export function StartupVarsPromptModal({
  prompt,
  onSubmit,
  onCancel,
}: StartupVarsPromptModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    // 기본값을 미리 채운다 — 그대로 확인하면 데스크톱과 같은 결과가 나온다.
    const next: Record<string, string> = {};
    for (const variable of prompt?.variables ?? []) {
      next[variable.name] = variable.defaultValue;
    }
    setValues(next);
  }, [prompt]);

  return (
    <Modal
      animationType="slide"
      transparent
      visible={Boolean(prompt)}
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
            <Text style={[styles.title, { color: palette.text }]}>
              {translate('startupVars.title')}
            </Text>
            <Text style={[styles.body, { color: palette.mutedText }]}>
              {translate('startupVars.subtitle', {
                host: prompt?.hostLabel ?? '',
              })}
            </Text>
            <Text style={[styles.command, { color: palette.mutedText }]}>
              {prompt?.command ?? ''}
            </Text>

            {(prompt?.variables ?? []).map(variable => (
              <View key={variable.name} style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { color: palette.text }]}>
                  {variable.name}
                </Text>
                <TextInput
                  value={values[variable.name] ?? ''}
                  onChangeText={text =>
                    setValues(current => ({
                      ...current,
                      [variable.name]: text,
                    }))
                  }
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={variable.defaultValue}
                  placeholderTextColor={palette.mutedText}
                  testID={`startup-var-${variable.name}`}
                  style={[
                    styles.input,
                    {
                      color: palette.text,
                      borderColor: palette.border,
                      backgroundColor: palette.input,
                    },
                  ]}
                />
              </View>
            ))}

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
                <Text
                  style={[styles.secondaryButtonText, { color: palette.text }]}
                >
                  {translate('startupVars.cancel')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => onSubmit(values)}
                style={[styles.primaryButton, { backgroundColor: palette.accent }]}
              >
                <Text style={styles.primaryButtonText}>
                  {translate('startupVars.confirm')}
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
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: '88%',
  },
  content: {
    padding: 22,
    gap: 14,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  command: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'Menlo',
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  primaryButton: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#04111A',
    fontSize: 15,
    fontWeight: '800',
  },
});
