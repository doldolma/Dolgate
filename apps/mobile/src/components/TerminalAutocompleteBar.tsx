import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TerminalAutocompleteSuggestion } from '@dolssh/shared-core';
import { useTranslation } from 'react-i18next';
import type { PendingAutocompleteSnippet } from '../hooks/useTerminalAutocomplete';
import { completionLabel } from '../lib/completion-label';
import { useMobilePalette } from '../theme';

interface TerminalAutocompleteBarProps {
  command: string;
  suggestions: readonly TerminalAutocompleteSuggestion[];
  pendingSnippet: PendingAutocompleteSnippet | null;
  onAccept: (suggestion: TerminalAutocompleteSuggestion) => void;
  onConfirmSnippet: (values: Record<string, string>) => void;
  onCancelSnippet: () => void;
}


export function TerminalAutocompleteBar({
  command,
  suggestions,
  pendingSnippet,
  onAccept,
  onConfirmSnippet,
  onCancelSnippet,
}: TerminalAutocompleteBarProps): React.JSX.Element | null {
  const palette = useMobilePalette();
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setValues(
      Object.fromEntries(
        (pendingSnippet?.variables ?? []).map(variable => [
          variable.name,
          variable.defaultValue,
        ]),
      ),
    );
  }, [pendingSnippet]);

  if (suggestions.length === 0 && !pendingSnippet) return null;

  return (
    <>
      {suggestions.length > 0 ? (
        <View
          style={[
            styles.bar,
            {
              backgroundColor: palette.sessionToolbar,
              borderTopColor: palette.sessionToolbarBorder,
            },
          ]}
        >
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.list}
          >
            {suggestions.map(suggestion => {
              const isSnippet = suggestion.source === 'snippet';
              // 넣는 값과 보여줄 이름이 다르면(제너레이터의 displayName) 그 이름을 쓴다 —
              // `docker logs` 는 `gds2` 를 넣으면서 `gds2 (nginx:latest)` 를 보여준다.
              const label =
                suggestion.displayText ??
                (isSnippet
                  ? suggestion.insertText
                  : completionLabel(command, suggestion.insertText));
              return (
                <Pressable
                  key={`${suggestion.source}:${suggestion.insertText}`}
                  accessibilityRole="button"
                  accessibilityLabel={suggestion.insertText}
                  onPress={() => onAccept(suggestion)}
                  style={({ pressed }) => [
                    styles.item,
                    {
                      backgroundColor: pressed
                        ? palette.accentSoft
                        : palette.surfaceAlt,
                      borderColor: pressed
                        ? palette.accent
                        : palette.sessionToolbarBorder,
                    },
                  ]}
                >
                  {/* 출처 라벨은 칩마다 적지 않는다. 한 묶음은 대체로 출처가 같아서 같은 말이
                      대여섯 번 반복되고, 좁은 화면에서 그 자리가 제일 비싸다. 사용자는 자기가
                      무엇을 치는 중인지 이미 안다. 그 자리에는 실제로 고르는 데 쓰이는 설명을
                      넣는다(있을 때만). */}
                  <View style={styles.itemText}>
                    <Text
                      numberOfLines={1}
                      style={[styles.command, { color: palette.text }]}
                    >
                      {label}
                    </Text>
                    {suggestion.description ? (
                      <Text
                        numberOfLines={1}
                        style={[styles.detail, { color: palette.mutedText }]}
                      >
                        {suggestion.description}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <Modal
        animationType="fade"
        transparent
        visible={pendingSnippet !== null}
        onRequestClose={onCancelSnippet}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          onPress={onCancelSnippet}
          style={[styles.backdrop, { backgroundColor: palette.overlay }]}
        >
          <Pressable
            onPress={event => event.stopPropagation()}
            style={[
              styles.dialog,
              {
                backgroundColor: palette.surface,
                borderColor: palette.sessionSurfaceBorder,
              },
            ]}
          >
            <Text style={[styles.title, { color: palette.text }]}>
              {t('session.autocomplete.snippetVariables')}
            </Text>
            {pendingSnippet?.variables.map(variable => (
              <View key={variable.name} style={styles.field}>
                <Text style={[styles.label, { color: palette.mutedText }]}>
                  {variable.name}
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={variable.defaultValue}
                  placeholderTextColor={palette.mutedText}
                  value={values[variable.name] ?? ''}
                  onChangeText={value =>
                    setValues(current => ({
                      ...current,
                      [variable.name]: value,
                    }))
                  }
                  style={[
                    styles.input,
                    {
                      backgroundColor: palette.surfaceAlt,
                      borderColor: palette.sessionToolbarBorder,
                      color: palette.text,
                    },
                  ]}
                />
              </View>
            ))}
            <View style={styles.actions}>
              <Pressable onPress={onCancelSnippet} style={styles.action}>
                <Text style={{ color: palette.mutedText }}>
                  {t('common.cancel')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => onConfirmSnippet(values)}
                style={[styles.action, { backgroundColor: palette.accent }]}
              >
                <Text style={{ color: palette.sessionToolbarActive }}>
                  {t('common.confirm')}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: 1,
    minHeight: 42,
  },
  list: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  item: {
    maxWidth: 280,
    // 설명이 붙으면 두 줄이 되므로 높이를 고정하지 않는다. minHeight 로 한 줄짜리 칩이
    // 예전과 같은 크기를 유지한다.
    minHeight: 32,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemText: {
    flexShrink: 1,
  },
  command: {
    maxWidth: 210,
    fontFamily: 'monospace',
    fontSize: 12,
  },
  detail: {
    maxWidth: 210,
    fontSize: 10,
  },
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  dialog: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
  },
  field: {
    gap: 5,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
  },
  input: {
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    fontSize: 14,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  action: {
    minHeight: 40,
    minWidth: 76,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
});
