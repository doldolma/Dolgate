// 호스트의 startup command 로 쓸 스니펫을 고른다.
//
// 고르기만 한다 — 모바일에서 스니펫을 만들거나 고치지는 않는다. 스니펫은 pull 로만 들어온다.

import React, { useMemo, useState } from 'react';
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
import type { SnippetRecord } from '@dolssh/shared-core';
import { useMobilePalette } from '../theme';

interface StartupSnippetPickerModalProps {
  visible: boolean;
  snippets: SnippetRecord[];
  selectedSnippetId: string | null;
  onSelect: (snippet: SnippetRecord) => void;
  onClose: () => void;
}

function matches(snippet: SnippetRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return (
    snippet.label.toLowerCase().includes(needle) ||
    snippet.command.toLowerCase().includes(needle) ||
    (snippet.keyword ?? '').toLowerCase().includes(needle)
  );
}

export function StartupSnippetPickerModal({
  visible,
  snippets,
  selectedSnippetId,
  onSelect,
  onClose,
}: StartupSnippetPickerModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const [query, setQuery] = useState('');

  const visibleSnippets = useMemo(
    () => snippets.filter(snippet => matches(snippet, query)),
    [snippets, query],
  );

  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={onClose}
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
          <View style={styles.header}>
            <Text style={[styles.title, { color: palette.text }]}>
              {translate('hostForm.startup.selectPlaceholder')}
            </Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={translate('hostForm.startup.searchPlaceholder')}
              placeholderTextColor={palette.mutedText}
              testID="startup-snippet-search"
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

          <ScrollView contentContainerStyle={styles.list}>
            {visibleSnippets.length === 0 ? (
              <Text style={[styles.empty, { color: palette.mutedText }]}>
                {translate('hostForm.startup.emptyText')}
              </Text>
            ) : (
              visibleSnippets.map(snippet => {
                const selected = snippet.id === selectedSnippetId;
                return (
                  <Pressable
                    key={snippet.id}
                    onPress={() => onSelect(snippet)}
                    testID={`startup-snippet-${snippet.id}`}
                    style={[
                      styles.row,
                      {
                        borderColor: selected ? palette.accent : palette.border,
                        backgroundColor: selected
                          ? palette.surfaceAlt
                          : 'transparent',
                      },
                    ]}
                  >
                    <Text style={[styles.rowLabel, { color: palette.text }]}>
                      {snippet.label}
                    </Text>
                    <Text
                      numberOfLines={2}
                      style={[styles.rowCommand, { color: palette.mutedText }]}
                    >
                      {snippet.command}
                    </Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>

          <Pressable
            onPress={onClose}
            style={[
              styles.closeButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.closeButtonText, { color: palette.text }]}>
              {translate('common.cancel')}
            </Text>
          </Pressable>
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
    maxHeight: '80%',
    paddingBottom: 22,
  },
  header: {
    padding: 22,
    paddingBottom: 12,
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
  },
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  list: {
    paddingHorizontal: 22,
    gap: 10,
  },
  empty: {
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 12,
  },
  row: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '700',
  },
  rowCommand: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Menlo',
  },
  closeButton: {
    marginHorizontal: 22,
    marginTop: 14,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
