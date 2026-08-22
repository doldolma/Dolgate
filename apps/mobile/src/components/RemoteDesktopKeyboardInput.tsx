/**
 * Dedicated remote keyboard input. VNC uses keysyms; RDP uses PS/2 set-1
 * scancodes for physical/special keys and Unicode events for composed text.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { RemoteDesktopProtocol } from '@dolssh/shared-core';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import {
  keyToKeysym,
  MODIFIER_KEYSYMS,
  type ModifierKey,
} from '../lib/vnc-keysym';
import {
  characterToRdpKeystroke,
  keyToRdpScancode,
  RDP_MODIFIER_SCANCODES,
  RDP_SPECIAL_KEY_SCANCODES,
  textToUnicodeCodepoints,
} from '../lib/rdp-keyboard';
import {
  TerminalInputView,
  type TerminalInputViewHandle,
} from './TerminalInputView';
import type { NativeTerminalInputEvent } from '../lib/terminal-input';

export interface RemoteDesktopKeyboardInputProps {
  protocol: RemoteDesktopProtocol;
  /** VNC consumes keysym; RDP consumes keycode. */
  onKeyEvent: (keysym: number, pressed: boolean, keycode?: number) => void;
  /** RDP Unicode input. VNC does not call this path. */
  onUnicodeEvent: (codepoint: number, pressed: boolean) => void;
  visible: boolean;
  onDismiss: () => void;
  /** 홈 인디케이터·노치 만큼의 여백. 바 **안쪽** 패딩으로 넣는다(아래 주석 참고). */
  insets?: { bottom: number; left: number; right: number };
}

const SPECIAL_KEYS: Array<{ label: string; key: string }> = [
  { label: 'Esc', key: 'Escape' },
  { label: 'Tab', key: 'Tab' },
  { label: '←', key: 'ArrowLeft' },
  { label: '↑', key: 'ArrowUp' },
  { label: '↓', key: 'ArrowDown' },
  { label: '→', key: 'ArrowRight' },
  { label: 'Del', key: 'Delete' },
  { label: 'Home', key: 'Home' },
  { label: 'End', key: 'End' },
  { label: 'PgUp', key: 'PageUp' },
  { label: 'PgDn', key: 'PageDown' },
];

/**
 * 네이티브 입력 뷰의 특수키 이름(터미널 용어) → VNC keysym 조회에 쓰는 DOM 키 이름.
 *
 * 두 이름 체계를 한 곳에서만 잇는다. 여러 곳에서 각자 변환하면 하나만 고쳐지는 순간 어긋난다.
 */
/** 바 버튼의 DOM 키 이름 → 네이티브 입력 뷰와 같은 특수키 이름. 경로를 하나로 모은다. */
const BAR_KEY_NAMES: Readonly<Record<string, string>> = {
  Meta: 'meta',
  Escape: 'escape',
  Tab: 'tab',
  Enter: 'enter',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'arrowUp',
  ArrowDown: 'arrowDown',
  ArrowLeft: 'arrowLeft',
  ArrowRight: 'arrowRight',
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
};

const VNC_SPECIAL_KEY_NAMES: Readonly<Record<string, string>> = {
  // 수정키 줄의 meta 는 Meta_L 을 보내지만, 한 번 눌러 떼는 이 키는 물리 윈도우키와 같은
  // Super_L 이어야 한다 — 리눅스 데스크톱의 단축키가 거기 걸려 있다.
  meta: 'Super',
  escape: 'Escape',
  tab: 'Tab',
  enter: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowUp: 'ArrowUp',
  arrowDown: 'ArrowDown',
  arrowLeft: 'ArrowLeft',
  arrowRight: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageUp: 'PageUp',
  pageDown: 'PageDown',
};

const EMPTY_MODIFIERS: Record<ModifierKey, boolean> = {
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
};

export function RemoteDesktopKeyboardInput({
  protocol,
  onKeyEvent,
  onUnicodeEvent,
  visible,
  onDismiss,
  insets,
}: RemoteDesktopKeyboardInputProps) {
  const { t } = useTranslation();
  const nativeInputRef = useRef<TerminalInputViewHandle | null>(null);
  /** 값이 바뀔 때마다 네이티브 뷰가 포커스를 다시 잡는다. */
  const [focusToken, setFocusToken] = useState(0);
  const [modifiers, setModifiers] = useState<Record<ModifierKey, boolean>>({
    ...EMPTY_MODIFIERS,
  });
  const modifiersRef = useRef(modifiers);
  const protocolRef = useRef(protocol);
  const onKeyEventRef = useRef(onKeyEvent);

  useEffect(() => {
    modifiersRef.current = modifiers;
  }, [modifiers]);

  /**
   * 네이티브 입력에 포커스를 요청한다.
   *
   * **토큰만 올리는 것으로는 부족하다.** 뷰가 붙기 전에 올린 값은 초기값으로 들어가 "변화"가
   * 아니게 되어 네이티브가 아무것도 하지 않는다. 터미널도 같은 이유로 `requestAnimationFrame`
   * 안에서 토큰 증가와 명령형 `focus()` 를 **함께** 부른다(SessionScreen 의
   * focusRequestedTerminalInput). 그 순서를 그대로 따른다.
   *
   * blur 에서는 되찾지 않는다 — focus↔blur 가 서로를 불러 IME 세션이 끊겼고 입력이 하나도
   * 들어오지 않았다.
   */
  const requestFocus = useCallback(() => {
    requestAnimationFrame(() => {
      setFocusToken(value => value + 1);
      nativeInputRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!visible) return;
    requestFocus();
  }, [requestFocus, visible]);

  useEffect(() => {
    protocolRef.current = protocol;
  }, [protocol]);

  useEffect(() => {
    onKeyEventRef.current = onKeyEvent;
  }, [onKeyEvent]);

  const sendModifier = useCallback(
    (mod: ModifierKey, pressed: boolean) => {
      if (protocol === 'rdp') {
        onKeyEvent(0, pressed, RDP_MODIFIER_SCANCODES[mod]);
      } else {
        onKeyEvent(MODIFIER_KEYSYMS[mod], pressed, 0);
      }
    },
    [onKeyEvent, protocol],
  );

  useEffect(
    () => () => {
      for (const mod of Object.keys(modifiersRef.current) as ModifierKey[]) {
        if (!modifiersRef.current[mod]) continue;
        if (protocolRef.current === 'rdp') {
          onKeyEventRef.current(0, false, RDP_MODIFIER_SCANCODES[mod]);
        } else {
          onKeyEventRef.current(MODIFIER_KEYSYMS[mod], false, 0);
        }
      }
    },
    [],
  );

  const toggleModifier = useCallback(
    (mod: ModifierKey) => {
      setModifiers(prev => {
        const next = { ...prev, [mod]: !prev[mod] };
        sendModifier(mod, next[mod]);
        return next;
      });
    },
    [sendModifier],
  );

  const releaseAllModifiers = useCallback(() => {
    setModifiers(prev => {
      let released = false;
      for (const mod of Object.keys(prev) as ModifierKey[]) {
        if (prev[mod]) {
          sendModifier(mod, false);
          released = true;
        }
      }
      return released ? { ...EMPTY_MODIFIERS } : prev;
    });
  }, [sendModifier]);

  useEffect(() => {
    if (!visible) releaseAllModifiers();
  }, [releaseAllModifiers, visible]);

  const handleDismiss = useCallback(() => {
    releaseAllModifiers();
    onDismiss();
  }, [onDismiss, releaseAllModifiers]);

  /**
   * 원격에 글자 하나를 보낸다. 스캔코드가 있으면 그 길로, 없으면 유니코드로.
   *
   * 둘 다 동작한다. 스캔코드를 먼저 쓰는 것은 modifier 와 같은 경로를 쓰기 때문이다 —
   * 유니코드 이벤트에는 Ctrl·Alt 개념이 없어서 조합키를 실을 수 없다.
   */
  /**
   * 특수키 하나를 보낸다. `ctrl` 이면 Ctrl 로 감싼다.
   *
   * 바의 특수키 버튼과 네이티브 입력의 `special-key` 가 같은 길을 쓴다 — 두 곳이 각자 매핑을
   * 들고 있으면 하나만 고쳐지는 순간 어긋난다.
   */
  const sendSpecialKey = useCallback(
    (key: string, ctrl: boolean) => {
      if (protocol === 'rdp') {
        const scancode =
          RDP_SPECIAL_KEY_SCANCODES[key] ?? keyToRdpScancode(key);
        if (scancode === null || scancode === undefined) return;
        if (ctrl) onKeyEvent(0, true, RDP_MODIFIER_SCANCODES.ctrl);
        onKeyEvent(0, true, scancode);
        onKeyEvent(0, false, scancode);
        if (ctrl) onKeyEvent(0, false, RDP_MODIFIER_SCANCODES.ctrl);
        return;
      }

      const keysym = keyToKeysym(VNC_SPECIAL_KEY_NAMES[key] ?? key);
      if (keysym === null) return;
      if (ctrl) onKeyEvent(MODIFIER_KEYSYMS.ctrl, true, 0);
      onKeyEvent(keysym, true, 0);
      onKeyEvent(keysym, false, 0);
      if (ctrl) onKeyEvent(MODIFIER_KEYSYMS.ctrl, false, 0);
    },
    [onKeyEvent, protocol],
  );

  const sendCharacter = useCallback(
    (character: string) => {
      if (protocol === 'rdp') {
        const stroke = characterToRdpKeystroke(character);
        if (stroke) {
          // **끈적이는 Shift 가 이미 눌려 있으면 감싸지 않는다.**
          //
          // 감싸면 우리가 보낸 shift-up 이 그 modifier 까지 풀어 버린다 — UI 는 Shift 가 켜져
          // 있다고 보여주는데 원격은 놓은 상태가 되어, 그다음 글자부터 조용히 소문자가 된다.
          const wrapShift = stroke.shift && !modifiersRef.current.shift;
          if (wrapShift) onKeyEvent(0, true, RDP_MODIFIER_SCANCODES.shift);
          onKeyEvent(0, true, stroke.scancode);
          onKeyEvent(0, false, stroke.scancode);
          if (wrapShift) onKeyEvent(0, false, RDP_MODIFIER_SCANCODES.shift);
          return;
        }
        for (const codepoint of textToUnicodeCodepoints(character)) {
          onUnicodeEvent(codepoint, true);
          onUnicodeEvent(codepoint, false);
        }
        return;
      }

      const keysym = keyToKeysym(character);
      if (keysym !== null) {
        onKeyEvent(keysym, true, 0);
        onKeyEvent(keysym, false, 0);
      }
    },
    [onKeyEvent, onUnicodeEvent, protocol],
  );

  /**
   * 네이티브 입력 뷰가 주는 두 가지를 그대로 원격 키 이벤트로 옮긴다.
   *
   * **여기서 추측하는 것이 없다는 점이 핵심이다.** 조합을 아는 쪽(IME)이 이미 "몇 글자 지우고
   * 무엇을 넣어라" 로 정리해서 준다. 예전에는 그것을 JS 에서 텍스트 상태 비교로 복원하려 했고,
   * 한글 조합·비우기 실패·포커스 루프가 겹쳐 매번 다르게 깨졌다.
   */
  const handleNativeInput = useCallback(
    (event: NativeTerminalInputEvent) => {
      if (event.kind === 'text-delta') {
        for (let index = 0; index < event.deleteCount; index += 1) {
          sendSpecialKey('backspace', false);
        }
        for (const character of event.insertText) {
          sendCharacter(character);
        }
        return;
      }
      sendSpecialKey(event.key, event.ctrl === true);
    },
    [sendCharacter, sendSpecialKey],
  );

  /** 바의 특수키 버튼. 네이티브 special-key 와 같은 경로를 쓴다. */
  /**
   * 특수키 줄. 맨 앞은 한 번 눌러 떼는 Win(리눅스는 Super) 키다.
   *
   * 수정키 줄의 Meta 와 **다른 동작**이다 — 그쪽은 누른 상태를 유지해 Win+R 같은 조합을 만들고,
   * 이쪽은 눌렀다 떼서 시작 메뉴를 연다. 윈도우가 시작 메뉴를 여는 시점이 키를 **놓을 때**라서
   * 토글로는 두 번 눌러야 했다.
   */
  const specialKeys = useMemo(
    () => [
      { label: protocol === 'rdp' ? 'Win' : 'Super', key: 'Meta' },
      ...SPECIAL_KEYS,
    ],
    [protocol],
  );

  const handleSpecialKey = useCallback(
    (key: string) => {
      sendSpecialKey(BAR_KEY_NAMES[key] ?? key, false);
      releaseAllModifiers();
    },
    [releaseAllModifiers, sendSpecialKey],
  );

  if (!visible) return null;

  return (
    <View
      // 인셋을 **바 안쪽 패딩으로** 넣는다.
      //
      // 감싸는 상자에 패딩을 주면 상자의 프레임과 그려지는 내용이 어긋날 수 있고, iOS 는
      // 부모 프레임 밖의 자식을 **보여는 주지만 터치는 주지 않는다** — 둘째 줄과 숨기기
      // 버튼이 눌리지 않던 모습이 정확히 그것이다. 상자를 하나로 두면 그 어긋남 자체가
      // 생기지 않고, 배경도 인셋까지 덮어 바가 바닥에 붙어 보인다.
      style={[
        styles.container,
        {
          paddingBottom: 6 + (insets?.bottom ?? 0),
          paddingLeft: insets?.left ?? 0,
          paddingRight: insets?.right ?? 0,
        },
      ]}
      // 포커스를 놓쳤을 때의 복구 경로. blur 에서 되찾으면 루프가 되므로, **사용자가 바를
      // 만지는 순간**에만 잡는다. 여기서 잡아 두면 modifier·특수키를 누른 뒤에도 타이핑이
      // 이어진다(그 버튼들이 포커스를 가져가기 때문).
      onTouchEnd={() => {
        if (visible) requestFocus();
      }}
    >
      <View style={styles.modifierRow}>
        {(Object.keys(MODIFIER_KEYSYMS) as ModifierKey[]).map(mod => (
          <Pressable
            key={mod}
            style={[styles.modKey, modifiers[mod] && styles.modKeyActive]}
            onPress={() => toggleModifier(mod)}
            accessibilityLabel={`${mod} modifier`}
            accessibilityState={{ selected: modifiers[mod] }}
          >
            <Text
              style={[
                styles.modKeyText,
                modifiers[mod] && styles.modKeyTextActive,
              ]}
            >
              {mod.charAt(0).toUpperCase() + mod.slice(1)}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={styles.dismissButton}
          onPress={handleDismiss}
          accessibilityLabel={t('session.rdKeyboardDismiss', {
            defaultValue: 'Dismiss keyboard',
          })}
        >
          <Ionicons name="chevron-down" size={18} color="#a0a0b8" />
        </Pressable>
      </View>

      <View style={styles.specialRow}>
        {specialKeys.map(item => (
          <Pressable
            key={item.key}
            style={styles.specialKey}
            onPress={() => handleSpecialKey(item.key)}
            accessibilityLabel={item.label}
          >
            <Text style={styles.specialKeyText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      {/**
        * **네이티브 입력 뷰를 쓴다.**
        *
        * 숨은 `TextInput` 은 "키를 눌렀다" 가 아니라 "텍스트가 이렇다" 만 준다. 그래서 눌린 키를
        * 텍스트 변화에서 역추적해야 하고, 한글 조합은 한 글자에 상태가 여러 번 바뀌어 그 추적이
        * 무너진다(`ㄱ가간가나`). 비우기(`setNativeProps`)도 이 RN 버전에서 듣지 않아 입력이
        * 누적됐고(`ASDD`), 포커스를 되찾으려 blur 에서 focus 를 부르면 IME 세션이 끊겨 아무것도
        * 안 들어왔다.
        *
        * 이 프로젝트는 터미널에서 같은 벽을 만나 네이티브 뷰로 해결해 두었다. 그 뷰는 조합 상태를
        * 아는 쪽에서 **델타(지울 개수 + 넣을 문자)** 와 **특수키**를 그대로 준다 — 우리가 추측할
        * 것이 없다. 소프트 키보드 띄우기도 그쪽이 담당한다(안드로이드 `showSoftInput`).
        */}
      <TerminalInputView
        ref={nativeInputRef}
        focused={visible}
        focusToken={focusToken}
        softKeyboardEnabled={Platform.OS === 'android' ? visible : undefined}
        onTerminalInput={event => handleNativeInput(event.nativeEvent)}
        style={styles.hiddenInput}
      />

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // 바가 스스로 바닥에 붙는다. 감싸는 상자를 두지 않으므로 프레임과 내용이 어긋날 자리가
    // 없다 — 모든 버튼이 이 상자 안에 있다.
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 6,
    backgroundColor: 'rgba(20, 20, 40, 0.95)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#3a3a5a',
    paddingTop: 6,
  },
  modifierRow: {
    flexDirection: 'row',
    // 수정키는 왼쪽, 숨기기는 오른쪽(marginLeft: 'auto'). center 를 주면 그 둘이 싸운다.
    justifyContent: 'flex-start',
    gap: 6,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  modKey: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#2a2a4a',
    borderWidth: 1,
    borderColor: '#3a3a5a',
  },
  modKeyActive: {
    backgroundColor: '#4a4a8a',
    borderColor: '#6a6aaa',
  },
  modKeyText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#a0a0b8',
  },
  modKeyTextActive: {
    color: '#e0e0f0',
  },
  dismissButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 'auto',
  },
  specialRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  specialKey: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 4,
    backgroundColor: '#2a2a4a',
    minWidth: 34,
    alignItems: 'center',
  },
  specialKeyText: {
    fontSize: 11,
    color: '#c0c0d8',
    fontWeight: '500',
  },
  /**
   * 키 입력을 받는 네이티브 뷰. 보이지 않지만 **포커스를 받을 수 있어야** 한다.
   *
   * `opacity: 0` 이나 크기 0 은 안 된다 — 그 상태에서는 포커스가 잡히지 않아 키 입력이 앱 레벨
   * 단축키로 흘렀고(시뮬레이터에서 타이핑하면 RN Dev Menu 가 떴다), 안드로이드에서는 IME 가
   * 붙지 않는다. 0 이 아닌 투명도와 실제 크기를 준다. 터미널 쪽도 같은 이유로 이렇게 둔다.
   */
  hiddenInput: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 2,
    height: 2,
    opacity: 0.01,
  },
});
