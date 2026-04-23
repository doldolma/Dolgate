package com.dolgate

import android.content.Context
import android.graphics.Color
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.widget.AppCompatEditText
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.uimanager.events.RCTEventEmitter

class TerminalInputViewManager : SimpleViewManager<TerminalInputEditText>() {
  override fun getName(): String = "TerminalInputView"

  override fun createViewInstance(reactContext: ThemedReactContext): TerminalInputEditText =
    TerminalInputEditText(reactContext)

  @ReactProp(name = "focused", defaultBoolean = false)
  fun setFocused(view: TerminalInputEditText, focused: Boolean) {
    view.setInputFocused(focused)
  }

  @ReactProp(name = "focusToken")
  fun setFocusToken(view: TerminalInputEditText, focusToken: Int?) {
    view.setFocusToken(focusToken ?: 0)
  }

  @ReactProp(name = "clearToken")
  fun setClearToken(view: TerminalInputEditText, clearToken: Int?) {
    view.setClearToken(clearToken ?: 0)
  }

  @ReactProp(name = "softKeyboardEnabled", defaultBoolean = true)
  fun setSoftKeyboardEnabled(view: TerminalInputEditText, softKeyboardEnabled: Boolean) {
    view.setSoftKeyboardEnabled(softKeyboardEnabled)
  }

  override fun getCommandsMap(): Map<String, Int> =
    mapOf(
      COMMAND_FOCUS to COMMAND_FOCUS_ID,
      COMMAND_BLUR to COMMAND_BLUR_ID,
    )

  override fun receiveCommand(
    view: TerminalInputEditText,
    commandId: Int,
    args: ReadableArray?,
  ) {
    when (commandId) {
      COMMAND_FOCUS_ID -> view.focusInput()
      COMMAND_BLUR_ID -> view.blurInput()
    }
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
    mapOf(
      EVENT_TERMINAL_INPUT to mapOf("registrationName" to EVENT_TERMINAL_INPUT),
    )

  private companion object {
    const val COMMAND_FOCUS = "focus"
    const val COMMAND_BLUR = "blur"
    const val COMMAND_FOCUS_ID = 1
    const val COMMAND_BLUR_ID = 2
    const val EVENT_TERMINAL_INPUT = "onTerminalInput"
  }
}

class TerminalInputEditText(
  reactContext: ThemedReactContext,
) : AppCompatEditText(reactContext) {
  private val inputMethodManager =
    reactContext.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
  private var previousValue = ""
  private var isInputFocused = false
  private var softKeyboardEnabled = true
  private var lastFocusToken = 0
  private var lastClearToken = 0
  private var suppressWatcher = false

  private val terminalTextWatcher =
    object : TextWatcher {
      override fun beforeTextChanged(
        s: CharSequence?,
        start: Int,
        count: Int,
        after: Int,
      ) = Unit

      override fun onTextChanged(
        s: CharSequence?,
        start: Int,
        before: Int,
        count: Int,
      ) = Unit

      override fun afterTextChanged(editable: Editable?) {
        if (suppressWatcher) {
          return
        }

        val nextValue = editable?.toString() ?: ""
        val delta = TerminalInputViewLogic.diffTextDelta(previousValue, nextValue)
        previousValue = nextValue
        moveCaretToEnd()

        if (delta.deleteCount == 0 && delta.insertText.isEmpty()) {
          return
        }

        emitTextDelta(delta)

        if (nextValue.length >= MAX_BUFFER_LENGTH) {
          resetBuffer(keepFocus = true)
        }
      }
    }

  init {
    setBackgroundColor(Color.TRANSPARENT)
    setTextColor(Color.TRANSPARENT)
    highlightColor = Color.TRANSPARENT
    setHintTextColor(Color.TRANSPARENT)
    setPadding(0, 0, 0, 0)
    isFocusable = true
    isFocusableInTouchMode = true
    isCursorVisible = false
    isLongClickable = false
    setTextIsSelectable(false)
    showSoftInputOnFocus = true
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
    }
    inputType =
      InputType.TYPE_CLASS_TEXT or
        InputType.TYPE_TEXT_FLAG_MULTI_LINE
    imeOptions =
      EditorInfo.IME_FLAG_NO_EXTRACT_UI or
        EditorInfo.IME_FLAG_NO_FULLSCREEN or
        EditorInfo.IME_FLAG_NO_ENTER_ACTION
    setSingleLine(false)
    setHorizontallyScrolling(false)
    addTextChangedListener(terminalTextWatcher)
    setOnEditorActionListener { _, actionId, event ->
      if (!TerminalInputViewLogic.isEnterEditorAction(actionId, event)) {
        return@setOnEditorActionListener false
      }

      emitSpecialKey(TerminalInputSpecialKeyPayload(key = "enter"))
      true
    }
  }

  override fun isSuggestionsEnabled(): Boolean = false

  override fun onCheckIsTextEditor(): Boolean = true

  override fun performLongClick(): Boolean = false

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    moveCaretToEnd()
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (handleTerminalKeyDown(keyCode, event)) {
      return true
    }

    return super.onKeyDown(keyCode, event)
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
    outAttrs.imeOptions = imeOptions
    outAttrs.inputType = inputType
    val baseConnection = super.onCreateInputConnection(outAttrs)
    return object : InputConnectionWrapper(baseConnection, true) {
      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (beforeLength > 0 && afterLength == 0 && previousValue.isEmpty()) {
          emitSpecialKey(TerminalInputSpecialKeyPayload(key = "backspace"))
          return true
        }

        return super.deleteSurroundingText(beforeLength, afterLength)
      }

      override fun sendKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && handleTerminalKeyDown(event.keyCode, event)) {
          return true
        }

        return super.sendKeyEvent(event)
      }

      override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        if (text?.contains("\n") == true) {
          text.forEach { character ->
            if (character == '\n') {
              emitSpecialKey(TerminalInputSpecialKeyPayload(key = "enter"))
            }
          }
          return true
        }

        return super.commitText(text, newCursorPosition)
      }
    }
  }

  fun setInputFocused(nextFocused: Boolean) {
    if (isInputFocused == nextFocused) {
      return
    }

    isInputFocused = nextFocused
    syncFocus(force = true)
  }

  fun setSoftKeyboardEnabled(enabled: Boolean) {
    if (softKeyboardEnabled == enabled) {
      return
    }

    softKeyboardEnabled = enabled
    showSoftInputOnFocus = enabled
    if (hasFocus()) {
      if (enabled) {
        showKeyboard()
      } else {
        hideKeyboard()
      }
    }
  }

  fun setFocusToken(focusToken: Int) {
    if (focusToken == lastFocusToken) {
      return
    }

    lastFocusToken = focusToken
    syncFocus(force = true)
  }

  fun setClearToken(clearToken: Int) {
    if (clearToken == lastClearToken) {
      return
    }

    lastClearToken = clearToken
    resetBuffer(keepFocus = isInputFocused)
  }

  fun focusInput() {
    isInputFocused = true
    syncFocus(force = true)
  }

  fun blurInput() {
    isInputFocused = false
    syncFocus(force = true)
  }

  private fun handleTerminalKeyDown(
    keyCode: Int,
    event: KeyEvent,
  ): Boolean {
    val specialKey = TerminalInputViewLogic.mapSpecialKey(keyCode, event.isCtrlPressed)
    if (specialKey != null) {
      emitSpecialKey(specialKey)
      return true
    }

    if (keyCode == KeyEvent.KEYCODE_DEL && previousValue.isEmpty()) {
      emitSpecialKey(TerminalInputSpecialKeyPayload(key = "backspace"))
      return true
    }

    return false
  }

  private fun syncFocus(force: Boolean = false) {
    post {
      if (isInputFocused) {
        if (force || !hasFocus()) {
          requestFocus()
        }
        moveCaretToEnd()
        updateKeyboardVisibility()
      } else {
        if (hasFocus()) {
          clearFocus()
        }
        hideKeyboard()
      }
    }
  }

  private fun updateKeyboardVisibility() {
    if (softKeyboardEnabled) {
      showKeyboard()
      return
    }
    hideKeyboard()
  }

  private fun showKeyboard() {
    post {
      showSoftInputOnFocus = true
      if (!hasFocus()) {
        requestFocus()
      }
      moveCaretToEnd()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        windowInsetsController?.show(WindowInsets.Type.ime())
      }
      inputMethodManager.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  private fun hideKeyboard() {
    showSoftInputOnFocus = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      windowInsetsController?.hide(WindowInsets.Type.ime())
    }
    inputMethodManager.hideSoftInputFromWindow(windowToken, 0)
  }

  private fun resetBuffer(keepFocus: Boolean) {
    previousValue = ""
    suppressWatcher = true
    setText("")
    suppressWatcher = false
    moveCaretToEnd()
    if (keepFocus) {
      syncFocus(force = true)
    }
  }

  private fun moveCaretToEnd() {
    val currentText = text ?: return
    val end = currentText.length
    if (selectionStart != end || selectionEnd != end) {
      setSelection(end)
    }
  }

  private fun emitTextDelta(delta: TerminalInputTextDelta) {
    val payload =
      Arguments.createMap().apply {
        putString("kind", "text-delta")
        putInt("deleteCount", delta.deleteCount)
        putString("insertText", delta.insertText)
      }
    emitTerminalInput(payload)
  }

  private fun emitSpecialKey(specialKey: TerminalInputSpecialKeyPayload) {
    val payload =
      Arguments.createMap().apply {
        putString("kind", "special-key")
        putString("key", specialKey.key)
        if (specialKey.ctrl) {
          putBoolean("ctrl", true)
        }
      }
    emitTerminalInput(payload)
  }

  private fun emitTerminalInput(payload: com.facebook.react.bridge.WritableMap) {
    val reactContext = context as? ReactContext ?: return
    reactContext
      .getJSModule(RCTEventEmitter::class.java)
      .receiveEvent(id, EVENT_TERMINAL_INPUT, payload)
  }

  private companion object {
    const val EVENT_TERMINAL_INPUT = "onTerminalInput"
    const val MAX_BUFFER_LENGTH = 96
  }
}
