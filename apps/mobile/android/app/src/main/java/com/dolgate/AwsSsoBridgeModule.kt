package com.dolgate

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.browser.customtabs.CustomTabsIntent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class AwsSsoBridgeModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())
  @Volatile
  private var serverSocket: ServerSocket? = null
  @Volatile
  private var deepLinkBaseUri: Uri? = null

  override fun getName(): String = "AwsSsoBridgeModule"

  @ReactMethod
  fun startLoopback(deepLinkBase: String, promise: Promise) {
    stopLoopbackInternal()
    val parsedDeepLinkBase = Uri.parse(deepLinkBase)
    deepLinkBaseUri = parsedDeepLinkBase

    try {
      val nextServerSocket = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
      serverSocket = nextServerSocket
      executor.execute {
        acceptLoop(nextServerSocket)
      }
      val payload =
        Arguments.createMap().apply {
          putString(
            "redirectUri",
            "http://127.0.0.1:${nextServerSocket.localPort}/oauth/callback",
          )
        }
      promise.resolve(payload)
    } catch (error: Exception) {
      promise.reject(
        "aws_sso_loopback_start_failed",
        error.message ?: "AWS SSO loopback 서버를 열지 못했습니다.",
        error,
      )
    }
  }

  @ReactMethod
  fun stopLoopback(promise: Promise) {
    stopLoopbackInternal()
    promise.resolve(null)
  }

  @ReactMethod
  fun openBrowser(url: String, promise: Promise) {
    try {
      val parsed = Uri.parse(url)
      runOnMainThread(
        {
          val current = reactApplicationContext.currentActivity
          if (current != null) {
            val intent = CustomTabsIntent.Builder().build()
            intent.launchUrl(current, parsed)
          } else {
            val fallback = Intent(Intent.ACTION_VIEW, parsed).apply {
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(fallback)
          }
          promise.resolve(null)
        },
        { error ->
          promise.reject(
            "aws_sso_browser_open_failed",
            error.message ?: "AWS SSO 브라우저를 열지 못했습니다.",
            error,
          )
        },
      )
    } catch (error: Exception) {
      promise.reject(
        "aws_sso_browser_open_failed",
        error.message ?: "AWS SSO 브라우저를 열지 못했습니다.",
        error,
      )
    }
  }

  @ReactMethod
  fun closeBrowser(promise: Promise) {
    promise.resolve(null)
  }

  private fun acceptLoop(listeningSocket: ServerSocket) {
    while (!listeningSocket.isClosed) {
      val socket =
        try {
          listeningSocket.accept()
        } catch (_: Exception) {
          return
        }
      handleConnection(socket)
      stopLoopbackInternal()
      return
    }
  }

  private fun handleConnection(socket: Socket) {
    socket.use { currentSocket ->
      val requestLine =
        BufferedReader(InputStreamReader(currentSocket.getInputStream(), StandardCharsets.UTF_8))
          .readLine()
          ?: return

      val target = parseRequestTarget(requestLine)
      if (target == null || target.path != "/oauth/callback") {
        writeResponse(currentSocket, 404, "<!doctype html><html><body>Not Found</body></html>")
        return
      }

      val deepLink = buildDeepLink(target)
      if (deepLink != null) {
        openApp(deepLink)
        writeResponse(currentSocket, 200, successHtml(deepLink))
        return
      }

      writeResponse(currentSocket, 400, "<!doctype html><html><body>Invalid callback</body></html>")
    }
  }

  private fun parseRequestTarget(requestLine: String): Uri? {
    val parts = requestLine.split(" ")
    if (parts.size < 2 || parts[0] != "GET") {
      return null
    }
    return Uri.parse("http://127.0.0.1${parts[1]}")
  }

  private fun buildDeepLink(target: Uri): Uri? {
    val base = deepLinkBaseUri ?: return null
    val builder = base.buildUpon().clearQuery()
    for (key in target.queryParameterNames) {
      target.getQueryParameters(key).forEach { value ->
        builder.appendQueryParameter(key, value)
      }
    }
    return builder.build()
  }

  private fun openApp(uri: Uri) {
    runOnMainThread(
      {
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
          addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
              Intent.FLAG_ACTIVITY_SINGLE_TOP or
              Intent.FLAG_ACTIVITY_CLEAR_TOP,
          )
        }
        reactApplicationContext.startActivity(intent)
      },
      { _ -> },
    )
  }

  private fun writeResponse(socket: Socket, statusCode: Int, body: String) {
    BufferedWriter(OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8)).use { writer ->
      writer.write(
        "HTTP/1.1 $statusCode ${statusText(statusCode)}\r\n" +
          "Content-Type: text/html; charset=utf-8\r\n" +
          "Cache-Control: no-store\r\n" +
          "Connection: close\r\n" +
          "Content-Length: ${body.toByteArray(StandardCharsets.UTF_8).size}\r\n" +
          "\r\n" +
          body,
      )
      writer.flush()
    }
  }

  private fun successHtml(deepLink: Uri): String {
    val href =
      deepLink.toString()
        .replace("&", "&amp;")
        .replace("\"", "&quot;")
    val scriptTarget =
      deepLink.toString()
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")

    return """
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Dolgate</title>
          <script>
            const target = "$scriptTarget";
            window.location.replace(target);
            setTimeout(() => { window.location.href = target; }, 120);
          </script>
        </head>
        <body style="font-family:sans-serif;padding:24px;">
          <h1 style="font-size:24px;margin:0 0 12px;">Dolgate</h1>
          <p style="margin:0 0 16px;">Returning to the app…</p>
          <a href="$href" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#0f62fe;color:#fff;text-decoration:none;">Open Dolgate</a>
        </body>
      </html>
    """.trimIndent()
  }

  private fun stopLoopbackInternal() {
    try {
      serverSocket?.close()
    } catch (_: Exception) {
    } finally {
      serverSocket = null
    }
  }

  private fun runOnMainThread(
    action: () -> Unit,
    onError: (Exception) -> Unit,
  ) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      try {
        action()
      } catch (error: Exception) {
        onError(error)
      }
      return
    }

    mainHandler.post {
      try {
        action()
      } catch (error: Exception) {
        onError(error)
      }
    }
  }

  private fun statusText(statusCode: Int): String =
    when (statusCode) {
      200 -> "OK"
      400 -> "Bad Request"
      404 -> "Not Found"
      else -> "OK"
    }
}
