/**
 * RemoteDesktopToolbar — compact floating toolbar for VNC/RDP sessions.
 *
 * Features: input mode toggle, keyboard, fit/100%, refresh, disconnect.
 * Precision pad is explicitly excluded from this iteration.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { RemoteDesktopInputMode, RemoteDesktopScaleMode } from '@dolssh/shared-core';
import { useTranslation } from 'react-i18next';

export interface RemoteDesktopToolbarProps {
  inputMode: RemoteDesktopInputMode;
  scaleMode: RemoteDesktopScaleMode;
  viewOnly: boolean;
  onToggleInputMode: () => void;
  onToggleKeyboard: () => void;
  onToggleScale: () => void;
  immersive: boolean;
  onToggleImmersive: () => void;
  /**
   * 가로 고정 토글. **지원하는 플랫폼에서만 넘어온다**(지금은 안드로이드) — 없으면 버튼도
   * 그리지 않는다. iOS 는 폰의 자동 회전을 그대로 따른다.
   */
  landscapeLocked?: boolean;
  onToggleLandscape?: () => void;
  /** 툴바를 접어 손잡이만 남긴다. */
  onCollapse: () => void;
  onSendClipboard: () => void;
  onDisconnect: () => void;
}

export function RemoteDesktopToolbar({
  inputMode,
  scaleMode,
  viewOnly,
  onToggleInputMode,
  onToggleKeyboard,
  onToggleScale,
  immersive,
  onToggleImmersive,
  landscapeLocked = false,
  onToggleLandscape,
  onCollapse,
  onSendClipboard,
  onDisconnect,
}: RemoteDesktopToolbarProps) {
  const { t } = useTranslation();

  const inputModeLabel =
    inputMode === 'trackpad'
      ? t('session.rdToolbarTrackpad', { defaultValue: 'Trackpad' })
      : inputMode === 'touch'
        ? t('session.rdToolbarDirectTouch', { defaultValue: 'Direct' })
        : t('session.rdToolbarInputNone', { defaultValue: 'View' });

  const scaleModeLabel =
    scaleMode === 'fit'
      ? t('session.rdToolbarFit', { defaultValue: 'Fit' })
      : scaleMode === 'native'
        ? '100%'
        : t('session.rdToolbarCustomZoom', { defaultValue: 'Zoom' });

  return (
    <View
      style={styles.container}
      accessibilityRole="toolbar"
      accessibilityLabel={t('session.rdToolbarLabel', {
        defaultValue: 'Remote desktop toolbar',
      })}
    >
      {/* 접기. 툴바가 원격 창의 제목줄 자리를 덮으므로 치울 수단이 필요하다.
          제스처로 감추면 좌클릭·길게누르기와 부딪히니 버튼으로 둔다. */}
      <Pressable
        style={styles.button}
        onPress={onCollapse}
        accessibilityRole="button"
        accessibilityLabel={t('session.rdToolbarCollapse', {
          defaultValue: '툴바 접기',
        })}
      >
        <Ionicons name="chevron-up" size={18} color="#8b8ba8" />
      </Pressable>

      {/* Input mode toggle (only when not viewOnly) */}
      {!viewOnly ? (
        <Pressable
          style={styles.button}
          onPress={onToggleInputMode}
          accessibilityLabel={t('session.rdToolbarToggleInput', {
            defaultValue: 'Toggle input mode',
          })}
          accessibilityHint={inputModeLabel}
        >
          <Ionicons
            name={inputMode === 'trackpad' ? 'hand-left-outline' : 'finger-print-outline'}
            size={18}
            color="#e0e0f0"
          />
          <Text style={styles.label}>{inputModeLabel}</Text>
        </Pressable>
      ) : null}

      {/* Keyboard toggle (only when not viewOnly) */}
      {!viewOnly ? (
        <Pressable
          style={styles.button}
          onPress={onToggleKeyboard}
          accessibilityLabel={t('session.rdToolbarKeyboard', {
            defaultValue: 'Toggle keyboard',
          })}
        >
          <Ionicons name="keypad-outline" size={18} color="#e0e0f0" />
        </Pressable>
      ) : null}

      {/* Scale mode toggle */}
      <Pressable
        style={styles.button}
        onPress={onToggleScale}
        accessibilityLabel={t('session.rdToolbarToggleScale', {
          defaultValue: 'Toggle scale mode',
        })}
        accessibilityHint={scaleModeLabel}
      >
        <Ionicons
          name={scaleMode === 'fit' ? 'expand-outline' : 'contract-outline'}
          size={18}
          color="#e0e0f0"
        />
        <Text style={styles.label}>{scaleModeLabel}</Text>
      </Pressable>

      {/* Immersive (fullscreen) toggle.
          배율 버튼이 이미 expand/contract 아이콘을 쓰므로 아이콘을 나누지 않고 하나로 두고
          켜졌을 때 색으로 알린다 — 작은 툴바에서 비슷한 화살표 아이콘이 둘이면 어느 쪽이
          전체화면인지 구분되지 않는다. */}
      <Pressable
        style={[styles.button, immersive && styles.buttonActive]}
        onPress={onToggleImmersive}
        accessibilityRole="button"
        accessibilityState={{ selected: immersive }}
        accessibilityLabel={
          immersive
            ? t('session.rdToolbarExitFullscreen', {
                defaultValue: '전체화면 끝내기',
              })
            : t('session.rdToolbarEnterFullscreen', {
                defaultValue: '전체화면',
              })
        }
      >
        <Ionicons
          name="scan-outline"
          size={18}
          color={immersive ? '#8ab4ff' : '#e0e0f0'}
        />
      </Pressable>

      {/* 가로 고정. 원격 데스크톱은 가로가 기본인데 폰의 자동 회전을 꺼 둔 사람은 세로로만
          보게 된다 — 시스템 설정을 건드리지 않고 여기서 뒤집는다. 세션을 벗어나면 자동으로
          풀린다(RemoteDesktopSurface). */}
      {onToggleLandscape ? (
        <Pressable
          style={[styles.button, landscapeLocked && styles.buttonActive]}
          onPress={onToggleLandscape}
          accessibilityRole="button"
          accessibilityState={{ selected: landscapeLocked }}
          accessibilityLabel={
            landscapeLocked
              ? t('session.rdToolbarUnlockRotation', {
                  defaultValue: '회전 잠금 풀기',
                })
              : t('session.rdToolbarLockLandscape', {
                  defaultValue: '가로로 고정',
                })
          }
        >
          <Ionicons
            name={landscapeLocked ? 'phone-portrait-outline' : 'phone-landscape-outline'}
            size={18}
            color={landscapeLocked ? '#8ab4ff' : '#e0e0f0'}
          />
        </Pressable>
      ) : null}

      {/* 화면 다시 받기 버튼은 두지 않는다. 화면이 정상일 때 누르면 서버가 같은 픽셀을 다시
          보내므로 눈에 보이는 변화가 없어 "고장난 버튼" 으로 읽히고, 아이콘도 회전으로
          오해된다. 대신 탭이 다시 활성화될 때 자동으로 부른다(RemoteDesktopSurface 참고) —
          프레임버퍼가 낡아 있을 수 있는 순간이 사실 그때뿐이다. */}

      {/* 기기 클립보드를 원격으로 보내고 원격에서 붙여넣는다. */}
      {!viewOnly ? (
        <Pressable
          style={styles.button}
          onPress={onSendClipboard}
          accessibilityLabel={t('session.rdToolbarSendClipboard', {
            defaultValue: 'Paste clipboard on the remote',
          })}
        >
          <Ionicons name="clipboard-outline" size={18} color="#e0e0f0" />
        </Pressable>
      ) : null}

      {/* Disconnect */}
      <Pressable
        style={[styles.button, styles.disconnectButton]}
        onPress={onDisconnect}
        accessibilityLabel={t('session.rdToolbarDisconnect', {
          defaultValue: 'Disconnect',
        })}
      >
        <Ionicons name="close-circle-outline" size={18} color="#ff6b6b" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: 'rgba(20, 20, 40, 0.88)',
    borderRadius: 10,
    alignSelf: 'center',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  buttonActive: {
    backgroundColor: 'rgba(138, 180, 255, 0.18)',
  },
  disconnectButton: {
    marginLeft: 4,
  },
  label: {
    fontSize: 11,
    color: '#c0c0d8',
    fontWeight: '600',
  },
});
