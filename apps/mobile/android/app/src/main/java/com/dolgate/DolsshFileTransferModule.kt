package com.dolgate

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.InputStream

class DolsshFileTransferModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
  private var pendingDownloadPromise: Promise? = null
  private var pendingDownloadName: String? = null
  private var pendingDownloadKind: PendingDownloadKind? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = "DolsshFileTransferModule"

  @ReactMethod
  fun pickDownloadDestination(fileName: String, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("download_destination_unavailable", "저장 위치를 열 화면을 찾지 못했습니다.")
      return
    }
    if (pendingDownloadPromise != null) {
      promise.reject("download_destination_busy", "이미 저장 위치를 선택하는 중입니다.")
      return
    }

    pendingDownloadPromise = promise
    pendingDownloadName = fileName
    pendingDownloadKind = PendingDownloadKind.FILE

    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "application/octet-stream"
      putExtra(Intent.EXTRA_TITLE, fileName)
    }

    try {
      activity.startActivityForResult(intent, REQUEST_CREATE_DOCUMENT)
    } catch (error: Exception) {
      clearPendingDownload()
      promise.reject(
        "download_destination_failed",
        error.message ?: "저장 위치 선택기를 열지 못했습니다.",
        error,
      )
    }
  }

  @ReactMethod
  fun pickDownloadDirectory(directoryName: String, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("download_directory_unavailable", "저장 폴더를 열 화면을 찾지 못했습니다.")
      return
    }
    if (pendingDownloadPromise != null) {
      promise.reject("download_directory_busy", "이미 저장 폴더를 선택하는 중입니다.")
      return
    }

    pendingDownloadPromise = promise
    pendingDownloadName = directoryName
    pendingDownloadKind = PendingDownloadKind.DIRECTORY

    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
    }

    try {
      activity.startActivityForResult(intent, REQUEST_OPEN_DOCUMENT_TREE)
    } catch (error: Exception) {
      clearPendingDownload()
      promise.reject(
        "download_directory_failed",
        error.message ?: "저장 폴더 선택기를 열지 못했습니다.",
        error,
      )
    }
  }

  @ReactMethod
  fun createDownloadDirectory(parentUri: String, directoryName: String, promise: Promise) {
    try {
      val directoryUri = createDocument(parentUri, directoryName, DocumentsContract.Document.MIME_TYPE_DIR)
      val payload = Arguments.createMap().apply {
        putString("uri", directoryUri.toString())
        putString("name", directoryName)
      }
      promise.resolve(payload)
    } catch (error: Exception) {
      promise.reject(
        "download_directory_create_failed",
        error.message ?: "다운로드 폴더를 만들지 못했습니다.",
        error,
      )
    }
  }

  @ReactMethod
  fun createDownloadFile(parentUri: String, fileName: String, promise: Promise) {
    try {
      val fileUri = createDocument(parentUri, fileName, "application/octet-stream")
      val payload = Arguments.createMap().apply {
        putString("uri", fileUri.toString())
        putString("name", fileName)
      }
      promise.resolve(payload)
    } catch (error: Exception) {
      promise.reject(
        "download_file_create_failed",
        error.message ?: "다운로드 파일을 만들지 못했습니다.",
        error,
      )
    }
  }

  @ReactMethod
  fun writeDownloadChunk(
    destinationUri: String,
    base64Chunk: String,
    append: Boolean,
    promise: Promise,
  ) {
    try {
      val uri = Uri.parse(destinationUri)
      val bytes = Base64.decode(base64Chunk, Base64.DEFAULT)
      val mode = if (append) "wa" else "w"
      reactApplicationContext.contentResolver.openOutputStream(uri, mode).use { output ->
        if (output == null) {
          throw IllegalStateException("저장 파일을 열지 못했습니다.")
        }
        output.write(bytes)
        output.flush()
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject(
        "download_write_failed",
        error.message ?: "다운로드 파일을 쓰지 못했습니다.",
        error,
      )
    }
  }

  @ReactMethod
  fun deleteDocument(destinationUri: String, promise: Promise) {
    try {
      val uri = Uri.parse(destinationUri)
      val deleted =
        if (DocumentsContract.isDocumentUri(reactApplicationContext, uri)) {
          DocumentsContract.deleteDocument(reactApplicationContext.contentResolver, uri)
        } else {
          reactApplicationContext.contentResolver.delete(uri, null, null) > 0
        }
      promise.resolve(deleted)
    } catch (error: Exception) {
      promise.reject(
        "document_delete_failed",
        error.message ?: "파일을 정리하지 못했습니다.",
        error,
      )
    }
  }

  @ReactMethod
  fun readLocalFileChunk(
    sourceUri: String,
    offset: Double,
    length: Double,
    promise: Promise,
  ) {
    try {
      val uri = Uri.parse(sourceUri)
      val requestedLength = length.toInt().coerceAtLeast(0)
      val buffer = ByteArray(requestedLength)
      val bytesRead =
        reactApplicationContext.contentResolver.openInputStream(uri).use { input ->
          if (input == null) {
            throw IllegalStateException("업로드 파일을 열지 못했습니다.")
          }
          skipFully(input, offset.toLong())
          input.read(buffer)
        }
      val safeBytesRead = bytesRead.coerceAtLeast(0)
      val payload = Arguments.createMap().apply {
        putString(
          "base64",
          Base64.encodeToString(buffer.copyOf(safeBytesRead), Base64.NO_WRAP),
        )
        putInt("bytesRead", safeBytesRead)
      }
      promise.resolve(payload)
    } catch (error: Exception) {
      promise.reject(
        "upload_read_failed",
        error.message ?: "업로드 파일을 읽지 못했습니다.",
        error,
      )
    }
  }

  override fun onActivityResult(
    activity: Activity,
    requestCode: Int,
    resultCode: Int,
    data: Intent?,
  ) {
    if (requestCode != REQUEST_CREATE_DOCUMENT && requestCode != REQUEST_OPEN_DOCUMENT_TREE) {
      return
    }

    val promise = pendingDownloadPromise ?: return
    val displayName = pendingDownloadName ?: "download"
    val kind = pendingDownloadKind ?: PendingDownloadKind.FILE
    clearPendingDownload()

    if (resultCode != Activity.RESULT_OK || data?.data == null) {
      promise.reject("DOCUMENT_PICKER_CANCELED", "저장 위치 선택이 취소되었습니다.")
      return
    }

    val uri = data.data!!
    val flags =
      data.flags and
        (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    try {
      reactApplicationContext.contentResolver.takePersistableUriPermission(uri, flags)
    } catch (_: Exception) {
    }

    val payloadUri =
      if (kind == PendingDownloadKind.DIRECTORY) {
        normalizeDirectoryUri(uri)
      } else {
        uri
      }
    val payload = Arguments.createMap().apply {
      putString("uri", payloadUri.toString())
      putString("name", displayName)
    }
    promise.resolve(payload)
  }

  override fun onNewIntent(intent: Intent) = Unit

  private fun clearPendingDownload() {
    pendingDownloadPromise = null
    pendingDownloadName = null
    pendingDownloadKind = null
  }

  private fun createDocument(parentUriString: String, requestedName: String, mimeType: String): Uri {
    val parentUri = normalizeDirectoryUri(Uri.parse(parentUriString))
    val safeName = requestedName.ifBlank { "download" }
    val uniqueName = resolveUniqueName(parentUri, safeName)
    return DocumentsContract.createDocument(
      reactApplicationContext.contentResolver,
      parentUri,
      mimeType,
      uniqueName,
    ) ?: throw IllegalStateException("문서를 만들지 못했습니다.")
  }

  private fun normalizeDirectoryUri(uri: Uri): Uri {
    return if (DocumentsContract.isTreeUri(uri)) {
      DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
    } else {
      uri
    }
  }

  private fun resolveUniqueName(parentUri: Uri, requestedName: String): String {
    val existingNames = readChildNames(parentUri)
    if (!existingNames.contains(requestedName)) {
      return requestedName
    }
    val extensionStart = requestedName.lastIndexOf('.').takeIf { it > 0 }
    val stem = extensionStart?.let { requestedName.substring(0, it) } ?: requestedName
    val extension = extensionStart?.let { requestedName.substring(it) } ?: ""
    var index = 1
    while (true) {
      val suffix = if (index == 1) " copy" else " copy $index"
      val candidate = "$stem$suffix$extension"
      if (!existingNames.contains(candidate)) {
        return candidate
      }
      index += 1
    }
  }

  private fun readChildNames(parentUri: Uri): Set<String> {
    val childrenUri =
      DocumentsContract.buildChildDocumentsUriUsingTree(
        parentUri,
        DocumentsContract.getDocumentId(parentUri),
      )
    val names = mutableSetOf<String>()
    reactApplicationContext.contentResolver.query(
      childrenUri,
      arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
      null,
      null,
      null,
    )?.use { cursor ->
      val nameColumn = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      while (cursor.moveToNext()) {
        if (nameColumn >= 0) {
          names.add(cursor.getString(nameColumn))
        }
      }
    }
    return names
  }

  private fun skipFully(input: InputStream, byteCount: Long) {
    var remaining = byteCount
    while (remaining > 0) {
      val skipped = input.skip(remaining)
      if (skipped <= 0) {
        if (input.read() == -1) {
          return
        }
        remaining -= 1
      } else {
        remaining -= skipped
      }
    }
  }

  private enum class PendingDownloadKind {
    FILE,
    DIRECTORY,
  }

  private companion object {
    const val REQUEST_CREATE_DOCUMENT = 4312
    const val REQUEST_OPEN_DOCUMENT_TREE = 4313
  }
}
