// 호스트 폼의 입력 행들. SSH 폼과 원격 데스크톱 폼이 나눠 쓴다.
//
// 라벨은 왼쪽에 남고 값이 그 오른쪽에 들어간다 — placeholder 만으로 라벨을 대신하면 값을
// 채운 순간 무슨 칸이었는지 사라진다(이 폼의 가장 큰 문제였다).

import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useMobilePalette } from '../theme';

export interface FieldRowProps {
  label: string;
  value: string;
  placeholder: string;
  onChangeText: (next: string) => void;
  keyboardType?: 'default' | 'number-pad';
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences';
  /** 목록에 항목을 더하는 칸에서 쓴다 — 키보드의 완료를 누르면 그 값이 들어간다. */
  onSubmitEditing?: () => void;
  submitLabel?: string;
}

export function FieldRow({
  label,
  value,
  placeholder,
  onChangeText,
  keyboardType = 'default',
  secureTextEntry = false,
  autoCapitalize = 'none',
  onSubmitEditing,
  submitLabel,
}: FieldRowProps): React.JSX.Element {
  const palette = useMobilePalette();
  return (
    <View style={styles.fieldRow}>
      <Text style={[styles.fieldLabel, { color: palette.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.tabInactive}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        returnKeyType={onSubmitEditing ? 'done' : 'default'}
        onSubmitEditing={onSubmitEditing}
        style={[styles.fieldInput, { color: palette.text }]}
      />
      {onSubmitEditing && submitLabel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={submitLabel}
          onPress={onSubmitEditing}
          hitSlop={8}
        >
          <Text style={[styles.fieldAdd, { color: palette.accent }]}>+</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 라벨 하나에 항목이 여러 개 달리는 칸 — 태그·환경 변수·점프 호스트. */
export type HostFormKind = 'ssh' | 'rdp' | 'vnc';

export interface ChipFieldChip {
  id: string;
  text: string;
}

interface FieldDraft {
  value: string;
  /** 읽어 주는 이름. */
  label: string;
  placeholder: string;
  onChangeText: (next: string) => void;
}

export interface ChipFieldProps {
  label: string;
  chips: ChipFieldChip[];
  /**
   * 지우는 버튼의 읽어 주는 이름. 무엇을 지우는지 알려면 항목 이름이 들어가야 한다.
   *
   * 칩을 통째로 넘긴다 — 환경 변수처럼 보이는 글자(`LANG=ko_KR`)와 부르는 이름(`LANG`)이
   * 다른 것이 있다.
   */
  removeLabel: (chip: ChipFieldChip) => string;
  onRemove: (id: string) => void;
  /** 그 자리에서 타이핑해 더하는 경우(태그·환경 변수). */
  input?: {
    value: string;
    /** 읽어 주는 이름 — placeholder 는 예시라("예: 운영") 무슨 칸인지 알려 주지 못한다. */
    label: string;
    placeholder: string;
    onChangeText: (next: string) => void;
    onSubmit: () => void;
  };
  /**
   * 이름과 값을 나눠 받는 경우(환경 변수).
   *
   * 한 칸에 `KEY=VALUE` 를 통째로 치게 하면 `=` 를 써야 한다는 걸 아는 사람만 넣을 수 있고,
   * 그걸 모르고 친 값은 아무 말 없이 버려진다.
   */
  pairInput?: {
    name: FieldDraft;
    value: FieldDraft;
    addLabel: string;
    onSubmit: () => void;
  };
  /** 눌러서 고르는 화면을 여는 경우(점프 호스트). */
  action?: { label: string; accessibilityLabel?: string; onPress: () => void };
  emptyText?: string;
}

// 지우는 길이 눈에 보여야 한다 — 항목을 눌러야 지워지는 목록은 아무도 못 찾는다(그리고
// 지우려던 게 아닌 사람이 실수로 지운다). 칩마다 ✕ 를 단다.
export function ChipField({
  label,
  chips,
  removeLabel,
  onRemove,
  input,
  pairInput,
  action,
  emptyText,
}: ChipFieldProps): React.JSX.Element {
  const palette = useMobilePalette();
  return (
    <View style={styles.chipField}>
      <Text style={[styles.chipLabel, { color: palette.text }]}>{label}</Text>
      <View style={styles.chipRow}>
        {chips.length === 0 && !input && emptyText ? (
          <Text style={[styles.chipEmpty, { color: palette.mutedText }]}>
            {emptyText}
          </Text>
        ) : null}
        {chips.map(chip => (
          <View
            key={chip.id}
            style={[
              styles.chip,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.chipText, { color: palette.text }]}>
              {chip.text}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={removeLabel(chip)}
              onPress={() => onRemove(chip.id)}
              hitSlop={10}
            >
              <Ionicons name="close" size={15} color={palette.mutedText} />
            </Pressable>
          </View>
        ))}
        {action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            onPress={action.onPress}
            style={[styles.chipAdd, { borderColor: palette.accentBorder }]}
          >
            <Ionicons name="add" size={15} color={palette.accent} />
            <Text style={[styles.chipAddText, { color: palette.accent }]}>
              {action.label}
            </Text>
          </Pressable>
        ) : null}
        {input ? (
          <TextInput
            accessibilityLabel={input.label}
            value={input.value}
            onChangeText={input.onChangeText}
            placeholder={input.placeholder}
            placeholderTextColor={palette.tabInactive}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={input.onSubmit}
            style={[styles.chipInput, { color: palette.text }]}
          />
        ) : null}
      </View>
      {pairInput ? (
        <View style={styles.pairRow}>
          <TextInput
            accessibilityLabel={pairInput.name.label}
            value={pairInput.name.value}
            onChangeText={pairInput.name.onChangeText}
            placeholder={pairInput.name.placeholder}
            placeholderTextColor={palette.tabInactive}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="next"
            style={[
              styles.pairInput,
              styles.pairName,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.input,
              },
            ]}
          />
          <Text style={[styles.pairEquals, { color: palette.mutedText }]}>=</Text>
          <TextInput
            accessibilityLabel={pairInput.value.label}
            value={pairInput.value.value}
            onChangeText={pairInput.value.onChangeText}
            placeholder={pairInput.value.placeholder}
            placeholderTextColor={palette.tabInactive}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={pairInput.onSubmit}
            style={[
              styles.pairInput,
              styles.pairValue,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.input,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pairInput.addLabel}
            onPress={pairInput.onSubmit}
            hitSlop={8}
          >
            <Ionicons
              name="add"
              size={22}
              // 이름이 비면 넣을 수 없다 — 눌러도 아무 일이 없다는 걸 색으로 먼저 알린다.
              color={
                pairInput.name.value.trim() ? palette.accent : palette.tabInactive
              }
            />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export interface SegmentedProps<T extends string> {
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  selected: T;
  onSelect: (next: T) => void;
}

// 인증 방식은 셋 중 하나를 고르는 단일 선택이라 하나의 트랙에 담는다. 예전에는 자격 증명
// 처리와 똑같이 생긴 알약 줄이 위아래로 붙어 있어, 성격이 다른 두 결정이 버튼 여섯 개짜리
// 한 덩어리로 읽혔다.
export function Segmented<T extends string>({
  options,
  selected,
  onSelect,
}: SegmentedProps<T>): React.JSX.Element {
  const palette = useMobilePalette();
  return (
    <View style={[styles.segmentTrack, { backgroundColor: palette.surface }]}>
      {options.map((option) => {
        const active = option.value === selected;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled: option.disabled }}
            disabled={option.disabled}
            onPress={() => onSelect(option.value)}
            style={[
              styles.segment,
              active ? { backgroundColor: palette.accentSoft } : null,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.segmentText,
                {
                  color: option.disabled
                    ? palette.tabInactive
                    : active
                      ? palette.accent
                      : palette.mutedText,
                },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 호스트 종류 칸. **새로 만들 때만** 보인다 — 이미 있는 호스트의 종류를 바꾸는 것은
 * 접속 방식과 자격 증명이 통째로 달라지는 일이라, 같은 레코드를 고치는 것으로 다룰 수 없다.
 *
 * 기본은 SSH 다. 폼을 열자마자 SSH 가 골라져 있어서 흔한 길에는 손이 더 들지 않는다.
 */
export function HostKindField({
  kind,
  kinds,
  onChange,
  label,
  disabledHint,
}: {
  kind: HostFormKind;
  /** 고를 수 있는 종류와, 지금 막혀 있는지. */
  kinds: ReadonlyArray<{ kind: HostFormKind; disabled: boolean }>;
  onChange: (next: HostFormKind) => void;
  label: string;
  /** 막힌 종류가 있을 때 왜 막혔는지. 누를 수 없는 칸은 이유가 안 보이면 고장으로 읽힌다. */
  disabledHint: string;
}): React.JSX.Element {
  const palette = useMobilePalette();
  const hasDisabled = kinds.some(entry => entry.disabled);
  return (
    <View style={styles.kindField}>
      <Text style={[styles.kindLabel, { color: palette.text }]}>{label}</Text>
      <Segmented
        options={kinds.map(entry => ({
          value: entry.kind,
          // 프로토콜 이름이라 번역하지 않는다(데스크톱과 같은 취급).
          label: entry.kind.toUpperCase(),
          disabled: entry.disabled,
        }))}
        selected={kind}
        onSelect={onChange}
      />
      {hasDisabled ? (
        <Text style={[styles.kindHint, { color: palette.mutedText }]}>
          {disabledHint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  // 폭을 고정하면 값들이 같은 선에서 시작해 표처럼 읽힌다.
  fieldLabel: {
    width: 90,
    fontSize: 17,
    fontWeight: '400',
    letterSpacing: -0.2,
  },
  fieldInput: {
    flex: 1,
    fontSize: 17,
    letterSpacing: -0.2,
    paddingVertical: 0,
  },
  fieldAdd: {
    fontSize: 22,
    fontWeight: '600',
    paddingHorizontal: 6,
  },
  chipField: {
    flex: 1,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  chipLabel: {
    fontSize: 17,
    fontWeight: '400',
    letterSpacing: -0.2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingLeft: 11,
    paddingRight: 8,
    paddingVertical: 6,
  },
  chipText: { fontSize: 14, letterSpacing: -0.2 },
  chipAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: 16,
    paddingLeft: 8,
    paddingRight: 11,
    paddingVertical: 6,
  },
  chipAddText: { fontSize: 14, fontWeight: '500', letterSpacing: -0.2 },
  // 칩 사이에 끼는 입력칸. 좁으면 두 글자만 보이므로 최소 폭을 준다.
  chipInput: {
    flexGrow: 1,
    minWidth: 120,
    fontSize: 15,
    paddingVertical: 4,
  },
  chipEmpty: { fontSize: 14, paddingVertical: 4 },
  segmentTrack: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: 14,
  },
  segment: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  segmentText: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  kindField: { gap: 6 },
  kindHint: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 4,
  },
  kindLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.1,
    paddingHorizontal: 4,
  },
  pairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pairInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
  },
  // 값이 이름보다 길다 — LANG=ko_KR.UTF-8.
  pairName: { flex: 1, minWidth: 0 },
  pairValue: { flex: 1.4, minWidth: 0 },
  pairEquals: { fontSize: 15 },
});
