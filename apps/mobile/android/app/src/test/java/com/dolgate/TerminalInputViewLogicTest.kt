package com.dolgate

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalInputViewLogicTest {
  @Test
  fun `diffTextDelta captures inserted characters`() {
    val delta = TerminalInputViewLogic.diffTextDelta("hel", "hello")

    assertEquals(0, delta.deleteCount)
    assertEquals("lo", delta.insertText)
  }

  @Test
  fun `diffTextDelta captures deletions`() {
    val delta = TerminalInputViewLogic.diffTextDelta("hello", "hel")

    assertEquals(2, delta.deleteCount)
    assertEquals("", delta.insertText)
  }

  @Test
  fun `mapSpecialKey maps terminal navigation keys`() {
    assertEquals(
      TerminalInputSpecialKeyPayload(key = "enter"),
      TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_ENTER, false),
    )
    assertEquals(
      TerminalInputSpecialKeyPayload(key = "tab"),
      TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_TAB, false),
    )
    assertEquals(
      TerminalInputSpecialKeyPayload(key = "arrowLeft"),
      TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_DPAD_LEFT, false),
    )
    assertEquals(
      TerminalInputSpecialKeyPayload(key = "pageDown"),
      TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_PAGE_DOWN, false),
    )
  }

  @Test
  fun `mapSpecialKey maps ctrl combinations`() {
    assertEquals(
      TerminalInputSpecialKeyPayload(key = "c", ctrl = true),
      TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_C, true),
    )
    assertEquals(
      TerminalInputSpecialKeyPayload(key = "d", ctrl = true),
      TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_D, true),
    )
    assertEquals(
      TerminalInputSpecialKeyPayload(key = "l", ctrl = true),
      TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_L, true),
    )
    assertEquals(
      TerminalInputSpecialKeyPayload(key = "z", ctrl = true),
      TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_Z, true),
    )
  }

  @Test
  fun `mapSpecialKey leaves text input keys untouched`() {
    assertNull(TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_A, false))
    assertNull(TerminalInputViewLogic.mapSpecialKey(KeyEvent.KEYCODE_SPACE, false))
  }

  @Test
  fun `isEnterEditorAction handles soft keyboard enter actions`() {
    assertTrue(
      TerminalInputViewLogic.isEnterEditorAction(EditorInfo.IME_ACTION_DONE, null),
    )
    assertTrue(
      TerminalInputViewLogic.isEnterEditorAction(EditorInfo.IME_ACTION_UNSPECIFIED, null),
    )
    assertTrue(
      TerminalInputViewLogic.isEnterEditorAction(EditorInfo.IME_NULL, null),
    )
  }

  @Test
  fun `isEnterEditorAction ignores hardware key events`() {
    val hardwareEvent = KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)

    assertEquals(
      false,
      TerminalInputViewLogic.isEnterEditorAction(EditorInfo.IME_ACTION_DONE, hardwareEvent),
    )
  }
}
