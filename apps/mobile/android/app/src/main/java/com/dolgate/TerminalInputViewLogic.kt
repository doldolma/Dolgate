package com.dolgate

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo

data class TerminalInputTextDelta(
  val deleteCount: Int,
  val insertText: String,
)

data class TerminalInputSpecialKeyPayload(
  val key: String,
  val ctrl: Boolean = false,
)

object TerminalInputViewLogic {
  fun diffTextDelta(previousValue: String, nextValue: String): TerminalInputTextDelta {
    var prefixLength = 0

    while (
      prefixLength < previousValue.length &&
        prefixLength < nextValue.length &&
        previousValue[prefixLength] == nextValue[prefixLength]
    ) {
      prefixLength += 1
    }

    return TerminalInputTextDelta(
      deleteCount = previousValue.length - prefixLength,
      insertText = nextValue.substring(prefixLength),
    )
  }

  fun mapSpecialKey(
    keyCode: Int,
    isCtrlPressed: Boolean,
  ): TerminalInputSpecialKeyPayload? {
    if (isCtrlPressed) {
      return when (keyCode) {
        KeyEvent.KEYCODE_C -> TerminalInputSpecialKeyPayload(key = "c", ctrl = true)
        KeyEvent.KEYCODE_D -> TerminalInputSpecialKeyPayload(key = "d", ctrl = true)
        KeyEvent.KEYCODE_L -> TerminalInputSpecialKeyPayload(key = "l", ctrl = true)
        KeyEvent.KEYCODE_Z -> TerminalInputSpecialKeyPayload(key = "z", ctrl = true)
        else -> null
      }
    }

    return when (keyCode) {
      KeyEvent.KEYCODE_ESCAPE -> TerminalInputSpecialKeyPayload(key = "escape")
      KeyEvent.KEYCODE_TAB -> TerminalInputSpecialKeyPayload(key = "tab")
      KeyEvent.KEYCODE_ENTER,
      KeyEvent.KEYCODE_NUMPAD_ENTER,
      -> TerminalInputSpecialKeyPayload(key = "enter")
      KeyEvent.KEYCODE_FORWARD_DEL -> TerminalInputSpecialKeyPayload(key = "delete")
      KeyEvent.KEYCODE_DPAD_UP -> TerminalInputSpecialKeyPayload(key = "arrowUp")
      KeyEvent.KEYCODE_DPAD_DOWN -> TerminalInputSpecialKeyPayload(key = "arrowDown")
      KeyEvent.KEYCODE_DPAD_LEFT -> TerminalInputSpecialKeyPayload(key = "arrowLeft")
      KeyEvent.KEYCODE_DPAD_RIGHT -> TerminalInputSpecialKeyPayload(key = "arrowRight")
      KeyEvent.KEYCODE_MOVE_HOME -> TerminalInputSpecialKeyPayload(key = "home")
      KeyEvent.KEYCODE_MOVE_END -> TerminalInputSpecialKeyPayload(key = "end")
      KeyEvent.KEYCODE_PAGE_UP -> TerminalInputSpecialKeyPayload(key = "pageUp")
      KeyEvent.KEYCODE_PAGE_DOWN -> TerminalInputSpecialKeyPayload(key = "pageDown")
      else -> null
    }
  }

  fun isEnterEditorAction(
    actionId: Int,
    event: KeyEvent?,
  ): Boolean {
    if (event != null) {
      return false
    }

    return when (actionId) {
      EditorInfo.IME_NULL,
      EditorInfo.IME_ACTION_DONE,
      EditorInfo.IME_ACTION_GO,
      EditorInfo.IME_ACTION_NEXT,
      EditorInfo.IME_ACTION_SEARCH,
      EditorInfo.IME_ACTION_SEND,
      EditorInfo.IME_ACTION_UNSPECIFIED,
      -> true
      else -> false
    }
  }
}
