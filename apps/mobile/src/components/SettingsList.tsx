import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useMobilePalette } from '../theme';

// 그룹 리스트의 구조(카드 하나에 행 여러 개, 행 사이 hairline, 그룹 분리)는 iOS 를 따르지만
// 겉모습은 이 앱의 것이다 — Home/Sessions 와 같은 radius 18, 굵은 라벨, 왼쪽 아이콘 타일.
// 정통 iOS 규격(radius 12, 17pt 400, 아이콘 없음)으로 두면 같은 앱 안에서 시각 언어가 둘로
// 갈려 시스템 기본 화면을 붙여 놓은 것처럼 보인다.

type RowTone = 'default' | 'accent' | 'danger' | 'muted';

// 아이콘 타일이 있는 행은 구분선도 라벨 시작점까지 밀어야 어긋나 보이지 않는다.
const ROW_PADDING = 16;
const ICON_TILE = 28;
const ICON_GAP = 11;

interface SettingsGroupProps {
  header?: string;
  footer?: string;
  footerTone?: 'muted' | 'danger' | 'warning';
  // 모달·시트 위에 놓이는 그룹 — 기본 surface 는 0.96 알파라 뒤 화면 글자가 비친다.
  solid?: boolean;
  children: React.ReactNode;
}

export function SettingsGroup({
  header,
  footer,
  footerTone = 'muted',
  solid = false,
  children,
}: SettingsGroupProps): React.JSX.Element {
  const palette = useMobilePalette();
  // 조건부로 빠진 행(null·false)은 toArray 가 걸러 주므로, 남은 행 수에 맞춰 구분선을 넣는다.
  const rows = React.Children.toArray(children);
  const footerColor =
    footerTone === 'danger'
      ? palette.danger
      : footerTone === 'warning'
      ? palette.warning
      : palette.mutedText;

  return (
    <View style={styles.group}>
      {header ? (
        <Text style={[styles.header, { color: palette.text }]}>{header}</Text>
      ) : null}
      <View
        style={[
          styles.card,
          {
            backgroundColor: solid ? palette.surfaceSolid : palette.surface,
          },
        ]}
      >
        {rows.map((row, index) => {
          const hasIcon =
            React.isValidElement<SettingsRowProps>(row) &&
            Boolean(row.props.icon);
          return (
            // eslint-disable-next-line react/no-array-index-key
            <React.Fragment key={index}>
              {index > 0 ? (
                <View
                  style={[
                    styles.separator,
                    {
                      backgroundColor: palette.border,
                      marginLeft: hasIcon
                        ? ROW_PADDING + ICON_TILE + ICON_GAP
                        : ROW_PADDING,
                    },
                  ]}
                />
              ) : null}
              {row}
            </React.Fragment>
          );
        })}
      </View>
      {footer ? (
        <Text style={[styles.footer, { color: footerColor }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

interface SettingsRowProps {
  label?: string;
  // 라벨 아래 줄 — 알고리즘 이름처럼 오른쪽 값으로 넣으면 좁아지는 것들이 여기 온다.
  subtitle?: string;
  value?: string;
  icon?: string;
  tone?: RowTone;
  align?: 'left' | 'center';
  chevron?: boolean;
  // 선택된 항목 표시 — 목록에서 하나를 고르는 시트에서 쓴다.
  check?: boolean;
  /**
   * 켜고 끄는 행. 값을 주면 오른쪽에 스위치가 붙고 행 전체가 그 스위치를 누른다.
   *
   * 체크 표시(`check`)와 다르다 — 체크는 "여럿 중 하나를 골랐다" 는 표시고, 스위치는 "이
   * 기능이 켜져 있다" 는 상태다. 둘을 섞으면 사용자가 목록에서 하나를 고르는 것인지 켜는
   * 것인지 알 수 없다.
   */
  toggle?: {
    value: boolean;
    onValueChange: (value: boolean) => void;
  };
  disabled?: boolean;
  accessibilityRole?: 'button' | 'link' | 'switch';
  accessibilityLabel?: string;
  accessibilityValue?: { text: string };
  onPress?: () => void;
  // 입력칸처럼 라벨 대신 행을 통째로 채우는 내용.
  children?: React.ReactNode;
}

export function SettingsRow({
  label,
  subtitle,
  value,
  icon,
  tone = 'default',
  align = 'left',
  chevron = false,
  check = false,
  toggle,
  disabled = false,
  accessibilityRole,
  accessibilityLabel,
  accessibilityValue,
  onPress,
  children,
}: SettingsRowProps): React.JSX.Element {
  const palette = useMobilePalette();
  // 누를 수 없는 행은 카드째로 흐리게 만들지 않고 글자만 회색으로 — 투명도를 내리면 카드가
  // 반투명해 보이고, iOS 도 비활성 동작을 회색 글자로 표시한다.
  const labelColor = disabled
    ? palette.tabInactive
    : tone === 'accent'
    ? palette.accent
    : tone === 'danger'
    ? palette.danger
    : tone === 'muted'
    ? palette.mutedText
    : palette.text;

  // 아이콘은 children 바깥에 둔다 — 안에 넣으면 입력칸처럼 children 을 넘긴 행에서 아이콘이
  // 함께 사라진다.
  const content = (
    <>
      {icon ? (
        <View
          style={[styles.iconTile, { backgroundColor: palette.accentSoft }]}
        >
          <Ionicons
            name={icon}
            size={16}
            color={tone === 'danger' ? palette.danger : palette.accent}
          />
        </View>
      ) : null}
      {children ?? (
        <>
          <View style={styles.rowCopy}>
            {label ? (
              <Text
                style={[
                  styles.rowLabel,
                  { color: labelColor },
                  align === 'center' ? styles.rowLabelCentered : null,
                ]}
              >
                {label}
              </Text>
            ) : null}
            {subtitle ? (
              <Text style={[styles.rowSubtitle, { color: palette.mutedText }]}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {value ? (
            <Text
              numberOfLines={1}
              style={[styles.rowValue, { color: palette.mutedText }]}
            >
              {value}
            </Text>
          ) : null}
          {check ? (
            <Ionicons name="checkmark" size={19} color={palette.accent} />
          ) : null}
          {toggle ? (
            // 켜진 트랙만 강조색으로 바꾸고 나머지는 플랫폼 기본을 쓴다. 꺼진 트랙·손잡이까지
            // 우리 색으로 덮으면(우리 팔레트의 테두리색은 알파가 0.08 이라) 꺼진 상태가 거의
            // 보이지 않고, 두 플랫폼의 익숙한 모양에서 멀어진다.
            <Switch
              disabled={disabled}
              value={toggle.value}
              onValueChange={toggle.onValueChange}
              trackColor={{ true: palette.accent }}
            />
          ) : null}
          {chevron ? (
            <Ionicons
              name="chevron-forward"
              size={16}
              color={palette.tabInactive}
            />
          ) : null}
        </>
      )}
    </>
  );

  // 스위치 행은 행 전체를 눌러도 토글된다 — 스위치만 누를 수 있게 두면 조준해야 한다.
  const handlePress = toggle
    ? () => toggle.onValueChange(!toggle.value)
    : onPress;

  if (!handlePress) {
    return <View style={styles.row}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole={
        accessibilityRole ?? (toggle ? 'switch' : 'button')
      }
      accessibilityState={toggle ? { checked: toggle.value } : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityValue}
      disabled={disabled}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.row,
        pressed ? { backgroundColor: palette.surfaceAlt } : null,
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {
    gap: 6,
  },
  // 머리글은 행보다 조용해야 한다 — 진하고 굵게 하면 행 라벨과 경쟁해 위계가 사라진다.
  header: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.1,
    paddingHorizontal: 4,
  },
  card: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  footer: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 4,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ICON_GAP,
    paddingHorizontal: ROW_PADDING,
    paddingVertical: 9,
  },
  iconTile: {
    width: ICON_TILE,
    height: ICON_TILE,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowCopy: {
    flex: 1,
    gap: 2,
  },
  // 라벨은 일반 굵기다 — 행이 열 개 넘는 목록에서 전부 굵게 하면 화면 전체가 강조가 된다.
  rowLabel: {
    fontSize: 17,
    fontWeight: '400',
    letterSpacing: -0.2,
  },
  rowLabelCentered: {
    textAlign: 'center',
  },
  rowSubtitle: {
    fontSize: 13,
    lineHeight: 17,
  },
  rowValue: {
    fontSize: 16,
    fontWeight: '400',
    letterSpacing: -0.1,
    flexShrink: 1,
    maxWidth: '50%',
    textAlign: 'right',
  },
});
