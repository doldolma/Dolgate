// 목록에서 고르는 시트. 그룹·Tailnet·점프 호스트가 나눠 쓴다.
//
// 겉모습은 앱의 설정 목록(SettingsGroup/SettingsRow)을 그대로 쓴다 — 고르는 화면만 테두리
// 친 카드를 줄줄이 세우면 같은 앱 안에서 목록이 두 가지 모양이 된다. 고른 항목은 체크
// 표시로만 알린다(iOS 규격).
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { useMobilePalette } from '../theme';

// 이만큼 넘어가면 검색칸을 보여 준다. 서너 개짜리 목록 위의 검색칸은 자리만 차지한다.
const SEARCH_THRESHOLD = 8;

export interface ListPickerItem {
  id: string;
  label: string;
  /** 라벨 아래 줄 — 상위 그룹 경로나 주소처럼 같은 이름을 구분해 주는 값. */
  detail?: string;
  icon?: string;
}

interface ListPickerModalProps {
  visible: boolean;
  title: string;
  items: ListPickerItem[];
  /** 고른 것들. 하나만 고르는 경우에도 배열로 다룬다. */
  selectedIds: string[];
  /** 여러 개를 고를 수 있는가. 점프 호스트가 그렇다(순서도 있다). */
  multiple?: boolean;
  searchPlaceholder: string;
  emptyText: string;
  /** "없음" 을 고를 수 있게 한다 — Tailnet 처럼 해제가 뜻이 있는 경우. */
  noneLabel?: string;
  /**
   * 더 고를 수 없을 때의 이유. 상한에 걸리면 누를 수 없게 하고 이 문구를 위에 띄운다 —
   * 눌러도 아무 일이 없는 목록은 고장으로 읽힌다.
   */
  limitNotice?: string;
  /** 목록 아래에 붙는 만들기 행 — 그룹처럼 여기서 새로 만들 수 있는 경우. */
  actionLabel?: string;
  actionIcon?: string;
  onAction?: () => void;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  /**
   * 이 시트 위에 겹쳐 뜨는 것(그룹 만들기 프롬프트 같은).
   *
   * **시트 밖에서 띄우면 안 된다** — iOS 는 이미 시트를 띄운 화면이 두 번째 모달을 띄우려
   * 하면 아무 말 없이 무시한다. 버튼을 눌러도 반응이 없는 것처럼 보인다.
   */
  children?: React.ReactNode;
}

function matches(item: ListPickerItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return (
    item.label.toLowerCase().includes(needle) ||
    (item.detail ?? '').toLowerCase().includes(needle)
  );
}

export function ListPickerModal({
  visible,
  title,
  items,
  selectedIds,
  multiple = false,
  searchPlaceholder,
  emptyText,
  noneLabel,
  limitNotice,
  actionLabel,
  actionIcon = 'add-outline',
  onAction,
  onSelect,
  onClose,
  children,
}: ListPickerModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t: translate } = useTranslation();
  const [query, setQuery] = useState('');

  // 닫히면 검색어를 버린다. 남겨 두면 다시 열었을 때 걸러진 목록이 나오고, 그 사이 항목이
  // 줄어 검색칸이 사라지면(8개 미만) 지울 수단 없이 항목이 없어진 것처럼 보인다.
  useEffect(() => {
    if (!visible) {
      setQuery('');
    }
  }, [visible]);

  const visibleItems = useMemo(
    () => items.filter(item => matches(item, query)),
    [items, query],
  );

  return (
    // 시트는 플랫폼에 맡긴다 — iOS 의 pageSheet 는 손잡이와 끌어내려 닫기를 OS 가 그려 주고,
    // 안드로이드에는 그런 시트가 없어 전체 화면 대화상자 + 뒤로가기가 제 방식이다. 직접 만든
    // 팬 제스처로 흉내 내면 두 플랫폼 어느 쪽의 감각과도 다른 것이 된다.
    <Modal
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={[styles.sheet, { backgroundColor: palette.background }]}>
        <View style={[styles.bar, { borderBottomColor: palette.border }]}>
          <View style={styles.barSide} />
          <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={translate(
              multiple ? 'common.done' : 'common.cancel',
            )}
            hitSlop={10}
            style={styles.barSide}
          >
            <Text style={[styles.barAction, { color: palette.accent }]}>
              {translate(multiple ? 'common.done' : 'common.cancel')}
            </Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.list}>
          {items.length >= SEARCH_THRESHOLD ? (
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={searchPlaceholder}
              placeholderTextColor={palette.mutedText}
              testID="list-picker-search"
              style={[
                styles.input,
                {
                  color: palette.text,
                  borderColor: palette.border,
                  backgroundColor: palette.input,
                },
              ]}
            />
          ) : null}

          {limitNotice ? (
            <Text style={[styles.notice, { color: palette.warning }]}>
              {limitNotice}
            </Text>
          ) : null}

          {visibleItems.length === 0 && !noneLabel ? (
            <Text style={[styles.empty, { color: palette.mutedText }]}>
              {emptyText}
            </Text>
          ) : (
            <SettingsGroup solid>
              {noneLabel ? (
                <SettingsRow
                  label={noneLabel}
                  tone="muted"
                  check={selectedIds.length === 0}
                  accessibilityLabel={noneLabel}
                  onPress={() => onSelect(null)}
                />
              ) : null}
              {visibleItems.map(item => {
                const selected = selectedIds.includes(item.id);
                return (
                  <SettingsRow
                    key={item.id}
                    icon={item.icon}
                    label={item.label}
                    subtitle={item.detail}
                    check={selected}
                    // 이미 고른 것은 상한에 걸려도 눌러야 한다 — 빼는 길이 막히면 안 된다.
                    disabled={Boolean(limitNotice) && !selected}
                    accessibilityLabel={item.label}
                    onPress={() => onSelect(item.id)}
                  />
                );
              })}
            </SettingsGroup>
          )}

          {actionLabel && onAction ? (
            <SettingsGroup solid>
              <SettingsRow
                icon={actionIcon}
                label={actionLabel}
                tone="accent"
                accessibilityLabel={actionLabel}
                onPress={onAction}
              />
            </SettingsGroup>
          ) : null}
        </ScrollView>
        {children}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  bar: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barSide: { minWidth: 52, alignItems: 'flex-end' },
  title: { flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  barAction: { fontSize: 16, fontWeight: '500' },
  list: { padding: 16, gap: 18 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  empty: { fontSize: 14, paddingVertical: 20, textAlign: 'center' },
  notice: { fontSize: 13, lineHeight: 18 },
});
