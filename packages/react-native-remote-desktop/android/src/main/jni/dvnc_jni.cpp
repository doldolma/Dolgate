/**
 * JNI bridge for the in-process VNC and RDP Rust cores.
 *
 * Rust callback pointers are borrowed. Everything reaching Kotlin stays inside Android
 * native/Kotlin code; none of it is emitted through React Native.
 *
 * Two shapes cross the boundary:
 *   - **Frames** are handed over as a direct `ByteBuffer` over the Rust pixels, so nothing is
 *     copied here. Kotlin must consume the buffer before the callback returns (`dispatch_frame`).
 *   - **Cursor shapes, audio, and RDP control JSON** are copied into Java arrays, because Kotlin
 *     retains them past the callback.
 */

#include <android/log.h>
#include <jni.h>
#include <pthread.h>

#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <string>
#include <vector>

#include "drdp_ffi.h"
#include "dvnc_ffi.h"

#define TAG "remote_desktop_jni"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static constexpr bool fits_uint16(jint value) {
    return value >= 0 &&
           value <= static_cast<jint>(std::numeric_limits<uint16_t>::max());
}

static constexpr bool fits_positive_uint16(jint value) {
    return value > 0 && fits_uint16(value);
}

static constexpr bool fits_uint8(jint value) {
    return value >= 0 &&
           value <= static_cast<jint>(std::numeric_limits<uint8_t>::max());
}

static constexpr bool fits_int16(jint value) {
    return value >= static_cast<jint>(std::numeric_limits<int16_t>::min()) &&
           value <= static_cast<jint>(std::numeric_limits<int16_t>::max());
}

static constexpr bool is_pointer_button(jint value) {
    return fits_uint8(value) && value <= 2;
}

static constexpr bool is_color_depth(jint value) {
    return value == 0 || value == 16 || value == 32;
}

static constexpr bool is_nonnegative_uint32(jint value) {
    return value >= 0;
}

static constexpr bool is_unicode_scalar(jint value) {
    return value >= 0 && value <= 0x10ffff &&
           !(value >= 0xd800 && value <= 0xdfff);
}

static_assert(fits_uint16(0) && fits_uint16(65535));
static_assert(!fits_uint16(-1) && !fits_uint16(65536));
static_assert(fits_positive_uint16(1) && !fits_positive_uint16(0));
static_assert(fits_uint8(0) && fits_uint8(255) && !fits_uint8(256));
static_assert(fits_int16(-32768) && fits_int16(32767));
static_assert(!fits_int16(-32769) && !fits_int16(32768));
static_assert(is_pointer_button(0) && is_pointer_button(2));
static_assert(!is_pointer_button(-1) && !is_pointer_button(3));
static_assert(is_color_depth(0) && is_color_depth(16) && is_color_depth(32));
static_assert(!is_color_depth(-1) && !is_color_depth(24));
static_assert(is_unicode_scalar(0) && is_unicode_scalar(0x10ffff));
static_assert(!is_unicode_scalar(-1) && !is_unicode_scalar(0xd800) &&
              !is_unicode_scalar(0x110000));

/// Method IDs resolved once at session creation.
///
/// **왜 캐시하는가:** 프레임 콜백은 갱신 한 번에 rect 여러 개로 들어온다. 그때마다
/// `GetObjectClass` + 문자열로 `GetMethodID` 를 하면 초당 수백 번의 조회가 핫패스에 얹힌다.
/// 콜백 객체의 클래스는 세션 수명 동안 바뀌지 않으므로 한 번만 찾으면 된다.
struct JniMethodIds {
    jmethodID connected;
    jmethodID resized;
    jmethodID capabilities;
    jmethodID clipboard;
    jmethodID error;
    jmethodID closed;
    jmethodID frame;
    jmethodID cursor;
    jmethodID rdp_event;
    jmethodID audio;
};

struct JniUserData {
    JavaVM *jvm;
    jobject callback_ref;
    jclass callback_class;
    JniMethodIds methods;
};

struct VncHandlePair {
    DvncSessionHandle session;
    JniUserData *user_data;
};

struct RdpHandlePair {
    DrdpSessionHandle session;
    JniUserData *user_data;
};

struct AttachedEnv {
    JNIEnv *env;
    /// True when this call attached the thread. Kept for readability only — nothing detaches per
    /// callback any more (see detach_on_thread_exit); only `env` is acted on.
    bool attached_here;
};

/// The JVM this thread was attached to, so the pthread destructor can detach it.
static JavaVM *g_attached_jvm = nullptr;
static pthread_key_t g_detach_key;
static pthread_once_t g_detach_key_once = PTHREAD_ONCE_INIT;

/// Runs when a worker thread exits. **A thread must be detached before it dies** — the VM aborts
/// the process otherwise ("native thread exited without detaching"). This is why we can keep the
/// thread attached across callbacks instead of attaching and detaching around every frame.
static void detach_on_thread_exit(void *value) {
    if (value == nullptr || g_attached_jvm == nullptr) return;
    g_attached_jvm->DetachCurrentThread();
}

static void make_detach_key() {
    pthread_key_create(&g_detach_key, detach_on_thread_exit);
}

static AttachedEnv attach_thread(JavaVM *jvm, const char *name) {
    JNIEnv *env = nullptr;
    const jint state = jvm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
    if (state == JNI_OK) {
        return {env, false};
    }
    if (state != JNI_EDETACHED) {
        LOGE("GetEnv failed: %d", state);
        return {nullptr, false};
    }

    JavaVMAttachArgs args{JNI_VERSION_1_6, const_cast<char *>(name), nullptr};
    if (jvm->AttachCurrentThread(&env, &args) != JNI_OK) {
        LOGE("AttachCurrentThread failed");
        return {nullptr, false};
    }

    // Stay attached for the life of this thread; detach from the pthread destructor.
    pthread_once(&g_detach_key_once, make_detach_key);
    g_attached_jvm = jvm;
    pthread_setspecific(g_detach_key, reinterpret_cast<void *>(1));
    return {env, true};
}

static void finish_callback(JniUserData *user_data, AttachedEnv attached) {
    (void) user_data;
    if (attached.env != nullptr && attached.env->ExceptionCheck()) {
        attached.env->ExceptionDescribe();
        attached.env->ExceptionClear();
    }
    // No DetachCurrentThread here — see detach_on_thread_exit.
}

static jbyteArray copy_bytes(JNIEnv *env, const uint8_t *bytes, uint32_t length) {
    if ((bytes == nullptr && length != 0) ||
        length > static_cast<uint32_t>(std::numeric_limits<jsize>::max())) {
        return nullptr;
    }
    auto result = env->NewByteArray(static_cast<jsize>(length));
    if (result != nullptr && length != 0) {
        env->SetByteArrayRegion(
            result,
            0,
            static_cast<jsize>(length),
            reinterpret_cast<const jbyte *>(bytes));
    }
    return result;
}

static bool standard_utf8_to_utf16(const char *value, std::vector<jchar> *result) {
    const auto *bytes = reinterpret_cast<const uint8_t *>(value);
    const size_t length = std::strlen(value);
    if (length > static_cast<size_t>(std::numeric_limits<jsize>::max())) return false;

    try {
        result->clear();
        result->reserve(length);
        for (size_t index = 0; index < length;) {
            const uint8_t lead = bytes[index];
            uint32_t codepoint = 0;
            size_t sequence_length = 0;
            uint32_t minimum = 0;
            if (lead <= 0x7f) {
                codepoint = lead;
                sequence_length = 1;
            } else if (lead >= 0xc2 && lead <= 0xdf) {
                codepoint = lead & 0x1f;
                sequence_length = 2;
                minimum = 0x80;
            } else if (lead >= 0xe0 && lead <= 0xef) {
                codepoint = lead & 0x0f;
                sequence_length = 3;
                minimum = 0x800;
            } else if (lead >= 0xf0 && lead <= 0xf4) {
                codepoint = lead & 0x07;
                sequence_length = 4;
                minimum = 0x10000;
            } else {
                return false;
            }

            if (sequence_length > length - index) return false;
            for (size_t offset = 1; offset < sequence_length; ++offset) {
                const uint8_t continuation = bytes[index + offset];
                if ((continuation & 0xc0) != 0x80) return false;
                codepoint = (codepoint << 6) | (continuation & 0x3f);
            }
            if (codepoint < minimum || codepoint > 0x10ffff ||
                (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
                return false;
            }

            if (codepoint <= 0xffff) {
                result->push_back(static_cast<jchar>(codepoint));
            } else {
                codepoint -= 0x10000;
                result->push_back(static_cast<jchar>(0xd800 + (codepoint >> 10)));
                result->push_back(static_cast<jchar>(0xdc00 + (codepoint & 0x3ff)));
            }
            index += sequence_length;
        }
    } catch (const std::bad_alloc &) {
        return false;
    }
    return true;
}

static jstring new_string_from_standard_utf8(JNIEnv *env, const char *value) {
    const char *safe_value = value == nullptr ? "" : value;
    std::vector<jchar> utf16;
    if (!standard_utf8_to_utf16(safe_value, &utf16)) {
        LOGE("native callback returned invalid standard UTF-8");
        return nullptr;
    }
    static const jchar empty = 0;
    return env->NewString(
        utf16.empty() ? &empty : utf16.data(),
        static_cast<jsize>(utf16.size()));
}

static void call_string_callback(
    JniUserData *user_data,
    jmethodID id,
    const char *value) {
    if (id == nullptr) return;
    auto attached = attach_thread(user_data->jvm, "remote-desktop-worker");
    if (attached.env == nullptr) return;
    JNIEnv *env = attached.env;
    jstring text = new_string_from_standard_utf8(env, value);
    if (text != nullptr) {
        env->CallVoidMethod(user_data->callback_ref, id, text);
        env->DeleteLocalRef(text);
    }
    finish_callback(user_data, attached);
}

/// Hands the frame rect to Kotlin **without copying the payload**.
///
/// The Rust pointer is valid for the duration of this call, and `handleFrame` copies straight into
/// its own framebuffer before returning, so a direct buffer is enough. The previous shape allocated
/// a `byte[]` per rect and copied twice (C→byte[]→framebuffer); a screen full of small rects turned
/// that into steady GC pressure on the frame path.
///
/// The buffer must not be retained past the callback. Cursor shapes are retained by Kotlin, which
/// is why they still arrive as a copied `byte[]`.
static void dispatch_frame(
    JniUserData *user_data,
    uint16_t x,
    uint16_t y,
    uint16_t width,
    uint16_t height,
    const uint8_t *pixels,
    uint32_t pixels_len) {
    if (user_data->methods.frame == nullptr) return;
    if (pixels == nullptr || pixels_len == 0) return;
    auto attached = attach_thread(user_data->jvm, "remote-desktop-frame");
    if (attached.env == nullptr) return;
    JNIEnv *env = attached.env;
    jobject buffer = env->NewDirectByteBuffer(
        const_cast<void *>(static_cast<const void *>(pixels)),
        static_cast<jlong>(pixels_len));
    if (buffer != nullptr) {
        env->CallVoidMethod(
            user_data->callback_ref,
            user_data->methods.frame,
            static_cast<jint>(x),
            static_cast<jint>(y),
            static_cast<jint>(width),
            static_cast<jint>(height),
            buffer);
        env->DeleteLocalRef(buffer);
    }
    finish_callback(user_data, attached);
}

// VNC callbacks.
static void on_vnc_connected(
    void *opaque, uint16_t width, uint16_t height, const char *name) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    auto attached = attach_thread(user_data->jvm, "vnc-connected");
    if (attached.env == nullptr) return;
    JNIEnv *env = attached.env;
    jmethodID id = user_data->methods.connected;
    if (id != nullptr) {
        jstring desktop_name = new_string_from_standard_utf8(env, name);
        if (desktop_name != nullptr) {
            env->CallVoidMethod(
                user_data->callback_ref,
                id,
                static_cast<jint>(width),
                static_cast<jint>(height),
                desktop_name);
            env->DeleteLocalRef(desktop_name);
        }
    }
    finish_callback(user_data, attached);
}

static void on_vnc_resized(void *opaque, uint16_t width, uint16_t height) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    auto attached = attach_thread(user_data->jvm, "vnc-resized");
    if (attached.env == nullptr) return;
    JNIEnv *env = attached.env;
    jmethodID id = user_data->methods.resized;
    if (id != nullptr) {
        env->CallVoidMethod(
            user_data->callback_ref,
            id,
            static_cast<jint>(width),
            static_cast<jint>(height));
    }
    finish_callback(user_data, attached);
}

static void on_vnc_capabilities(void *opaque, const char *json) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    call_string_callback(
        user_data, user_data->methods.capabilities, json == nullptr ? "{}" : json);
}

static void on_vnc_clipboard(void *opaque, const char *text) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    call_string_callback(user_data, user_data->methods.clipboard, text);
}

static void on_vnc_error(void *opaque, const char *message) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    call_string_callback(
        user_data,
        user_data->methods.error,
        message == nullptr ? "unknown VNC error" : message);
}

static void on_vnc_closed(void *opaque) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    auto attached = attach_thread(user_data->jvm, "vnc-closed");
    if (attached.env == nullptr) return;
    JNIEnv *env = attached.env;
    jmethodID id = user_data->methods.closed;
    if (id != nullptr) env->CallVoidMethod(user_data->callback_ref, id);
    finish_callback(user_data, attached);
}

static void on_vnc_frame(
    void *opaque,
    uint16_t x,
    uint16_t y,
    uint16_t width,
    uint16_t height,
    const uint8_t *pixels,
    uint32_t pixels_len) {
    dispatch_frame(
        static_cast<JniUserData *>(opaque),
        x,
        y,
        width,
        height,
        pixels,
        pixels_len);
}

static void on_vnc_cursor(
    void *opaque,
    uint16_t hotspot_x,
    uint16_t hotspot_y,
    uint16_t width,
    uint16_t height,
    const uint8_t *rgba,
    uint32_t rgba_len) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    auto attached = attach_thread(user_data->jvm, "vnc-cursor");
    if (attached.env == nullptr) return;
    JNIEnv *env = attached.env;
    jmethodID id = user_data->methods.cursor;
    if (id != nullptr) {
        jbyteArray copied = copy_bytes(env, rgba, rgba_len);
        if (copied != nullptr) {
            env->CallVoidMethod(
                user_data->callback_ref,
                id,
                static_cast<jint>(hotspot_x),
                static_cast<jint>(hotspot_y),
                static_cast<jint>(width),
                static_cast<jint>(height),
                copied);
            env->DeleteLocalRef(copied);
        }
    }
    finish_callback(user_data, attached);
}

// RDP callbacks.
static void on_rdp_event(void *opaque, const uint8_t *json, uint32_t json_len) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    auto attached = attach_thread(user_data->jvm, "rdp-event");
    if (attached.env == nullptr) return;
    JNIEnv *env = attached.env;
    jmethodID id = user_data->methods.rdp_event;
    if (id != nullptr) {
        jbyteArray copied = copy_bytes(env, json, json_len);
        if (copied != nullptr) {
            env->CallVoidMethod(user_data->callback_ref, id, copied);
            env->DeleteLocalRef(copied);
        }
    }
    finish_callback(user_data, attached);
}

static void on_rdp_frame(
    void *opaque,
    uint16_t x,
    uint16_t y,
    uint16_t width,
    uint16_t height,
    const uint8_t *pixels,
    uint32_t pixels_len) {
    dispatch_frame(
        static_cast<JniUserData *>(opaque),
        x,
        y,
        width,
        height,
        pixels,
        pixels_len);
}

static void on_rdp_audio(
    void *opaque,
    uint32_t sample_rate,
    uint16_t channels,
    uint16_t bits_per_sample,
    uint32_t timestamp,
    const uint8_t *samples,
    uint32_t samples_len) {
    auto *user_data = static_cast<JniUserData *>(opaque);
    auto attached = attach_thread(user_data->jvm, "rdp-audio");
    if (attached.env == nullptr) return;
    JNIEnv *env = attached.env;
    jmethodID id = user_data->methods.audio;
    if (id != nullptr) {
        jbyteArray copied = copy_bytes(env, samples, samples_len);
        if (copied != nullptr) {
            env->CallVoidMethod(
                user_data->callback_ref,
                id,
                static_cast<jint>(sample_rate),
                static_cast<jint>(channels),
                static_cast<jint>(bits_per_sample),
                static_cast<jint>(timestamp),
                copied);
            env->DeleteLocalRef(copied);
        }
    }
    finish_callback(user_data, attached);
}

static void append_standard_utf8(uint32_t codepoint, std::string *result) {
    if (codepoint <= 0x7f) {
        result->push_back(static_cast<char>(codepoint));
    } else if (codepoint <= 0x7ff) {
        result->push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
        result->push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    } else if (codepoint <= 0xffff) {
        result->push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
        result->push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
        result->push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    } else {
        result->push_back(static_cast<char>(0xf0 | (codepoint >> 18)));
        result->push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3f)));
        result->push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
        result->push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    }
}

static bool java_utf16_to_standard_utf8(
    const jchar *chars,
    jsize length,
    std::string *result) {
    try {
        result->clear();
        result->reserve(static_cast<size_t>(length));
        for (jsize index = 0; index < length; ++index) {
            uint32_t codepoint = chars[index];
            // Rust FFI accepts NUL-terminated strings, so embedded NUL must not truncate input.
            if (codepoint == 0) return false;
            if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
                if (index + 1 >= length) return false;
                const uint32_t low = chars[++index];
                if (low < 0xdc00 || low > 0xdfff) return false;
                codepoint = 0x10000 + ((codepoint - 0xd800) << 10) + (low - 0xdc00);
            } else if (codepoint >= 0xdc00 && codepoint <= 0xdfff) {
                return false;
            }
            append_standard_utf8(codepoint, result);
        }
    } catch (const std::bad_alloc &) {
        return false;
    }
    return true;
}

class StandardUtf8Chars {
public:
    StandardUtf8Chars(JNIEnv *env, jstring value) : valid_(value == nullptr) {
        if (value == nullptr) return;
        const jsize length = env->GetStringLength(value);
        const jchar *chars = env->GetStringChars(value, nullptr);
        if (chars == nullptr) return;
        valid_ = java_utf16_to_standard_utf8(chars, length, &value_);
        env->ReleaseStringChars(value, chars);
    }

    bool valid() const { return valid_; }
    const char *get() const { return value_.c_str(); }

private:
    std::string value_;
    bool valid_;
};

static JniUserData *create_user_data(JNIEnv *env, jobject callback) {
    if (callback == nullptr) return nullptr;
    JavaVM *jvm = nullptr;
    if (env->GetJavaVM(&jvm) != JNI_OK) return nullptr;
    jobject global = env->NewGlobalRef(callback);
    if (global == nullptr) return nullptr;

    jclass local_class = env->GetObjectClass(global);
    jclass global_class = local_class == nullptr
        ? nullptr
        : static_cast<jclass>(env->NewGlobalRef(local_class));
    if (local_class != nullptr) env->DeleteLocalRef(local_class);
    if (global_class == nullptr) {
        env->DeleteGlobalRef(global);
        return nullptr;
    }

    // Resolve every id up front. A missing signature here is a build-time mismatch between this
    // file and NativeSessionCallback.kt, and it must not surface as a silently dropped frame.
    JniMethodIds methods{};
    methods.connected =
        env->GetMethodID(global_class, "onConnected", "(IILjava/lang/String;)V");
    methods.resized = env->GetMethodID(global_class, "onResized", "(II)V");
    methods.capabilities =
        env->GetMethodID(global_class, "onCapabilities", "(Ljava/lang/String;)V");
    methods.clipboard =
        env->GetMethodID(global_class, "onClipboard", "(Ljava/lang/String;)V");
    methods.error = env->GetMethodID(global_class, "onError", "(Ljava/lang/String;)V");
    methods.closed = env->GetMethodID(global_class, "onClosed", "()V");
    methods.frame =
        env->GetMethodID(global_class, "onFrame", "(IIIILjava/nio/ByteBuffer;)V");
    methods.cursor = env->GetMethodID(global_class, "onCursor", "(IIII[B)V");
    methods.rdp_event = env->GetMethodID(global_class, "onRdpEvent", "([B)V");
    methods.audio = env->GetMethodID(global_class, "onAudio", "(IIII[B)V");

    if (env->ExceptionCheck()) {
        env->ExceptionDescribe();
        env->ExceptionClear();
    }
    const bool resolved = methods.connected != nullptr && methods.resized != nullptr &&
                          methods.capabilities != nullptr && methods.clipboard != nullptr &&
                          methods.error != nullptr && methods.closed != nullptr &&
                          methods.frame != nullptr && methods.cursor != nullptr &&
                          methods.rdp_event != nullptr && methods.audio != nullptr;
    if (!resolved) {
        LOGE("NativeSessionCallback method lookup failed — signatures out of sync");
        env->DeleteGlobalRef(global_class);
        env->DeleteGlobalRef(global);
        return nullptr;
    }

    return new JniUserData{jvm, global, global_class, methods};
}

static void destroy_user_data(JNIEnv *env, JniUserData *user_data) {
    if (user_data == nullptr) return;
    env->DeleteGlobalRef(user_data->callback_class);
    env->DeleteGlobalRef(user_data->callback_ref);
    delete user_data;
}

extern "C" {

// VNC lifecycle and controls (existing Java names retained).
JNIEXPORT jlong JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeCreate(
    JNIEnv *env, jobject, jobject callback) {
    JniUserData *user_data = create_user_data(env, callback);
    if (user_data == nullptr) return 0;
    DvncCallbacks callbacks{};
    callbacks.user_data = user_data;
    callbacks.on_connected = on_vnc_connected;
    callbacks.on_resized = on_vnc_resized;
    callbacks.on_capabilities = on_vnc_capabilities;
    callbacks.on_clipboard = on_vnc_clipboard;
    callbacks.on_error = on_vnc_error;
    callbacks.on_closed = on_vnc_closed;
    callbacks.on_frame = on_vnc_frame;
    callbacks.on_cursor = on_vnc_cursor;

    DvncSessionHandle handle = nullptr;
    if (dvnc_session_create(&callbacks, &handle) != DVNC_OK || handle == nullptr) {
        destroy_user_data(env, user_data);
        return 0;
    }
    return reinterpret_cast<jlong>(new VncHandlePair{handle, user_data});
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeStart(
    JNIEnv *env,
    jobject,
    jlong native_handle,
    jstring host,
    jint port,
    jstring password,
    jstring username,
    jstring image_quality,
    jstring tunnel_auth_token,
    jboolean shared) {
    if (native_handle == 0 || host == nullptr) return DVNC_ERR_NULL;
    if (!fits_positive_uint16(port)) return DVNC_ERR_INVALID_ARGUMENT;
    auto *pair = reinterpret_cast<VncHandlePair *>(native_handle);
    StandardUtf8Chars host_chars(env, host);
    StandardUtf8Chars password_chars(env, password);
    StandardUtf8Chars username_chars(env, username);
    StandardUtf8Chars quality_chars(env, image_quality);
    StandardUtf8Chars tunnel_auth_chars(env, tunnel_auth_token);
    if (!host_chars.valid() || !password_chars.valid() ||
        !username_chars.valid() || !quality_chars.valid() ||
        !tunnel_auth_chars.valid()) {
        return DVNC_ERR_INVALID_UTF8;
    }
    DvncConnectConfig config{};
    config.host = host_chars.get();
    config.port = static_cast<uint16_t>(port);
    config.password = password_chars.get();
    config.username = username_chars.get();
    config.image_quality = quality_chars.get();
    config.shared = shared ? 1 : 0;
    config.tunnel_auth_token = tunnel_auth_chars.get();
    return dvnc_session_start(pair->session, &config);
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeDisconnect(
    JNIEnv *, jobject, jlong native_handle) {
    if (native_handle == 0) return DVNC_ERR_NULL;
    return dvnc_session_disconnect(
        reinterpret_cast<VncHandlePair *>(native_handle)->session);
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeDestroy(
    JNIEnv *env, jobject, jlong native_handle) {
    if (native_handle == 0) return DVNC_ERR_NULL;
    auto *pair = reinterpret_cast<VncHandlePair *>(native_handle);
    const int32_t result = dvnc_session_destroy(pair->session);
    if (result == DVNC_OK) {
        destroy_user_data(env, pair->user_data);
        delete pair;
    }
    return result;
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativePointerMove(
    JNIEnv *, jobject, jlong handle, jint x, jint y) {
    if (handle == 0) return DVNC_ERR_NULL;
    if (!fits_uint16(x) || !fits_uint16(y)) return DVNC_ERR_INVALID_ARGUMENT;
    return dvnc_session_pointer_move(
        reinterpret_cast<VncHandlePair *>(handle)->session,
        static_cast<uint16_t>(x),
        static_cast<uint16_t>(y));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativePointerButton(
    JNIEnv *, jobject, jlong handle, jint button, jboolean pressed, jint x, jint y) {
    if (handle == 0) return DVNC_ERR_NULL;
    if (!is_pointer_button(button) || !fits_uint16(x) || !fits_uint16(y)) {
        return DVNC_ERR_INVALID_ARGUMENT;
    }
    return dvnc_session_pointer_button(
        reinterpret_cast<VncHandlePair *>(handle)->session,
        static_cast<uint8_t>(button),
        pressed ? 1 : 0,
        static_cast<uint16_t>(x),
        static_cast<uint16_t>(y));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativePointerScroll(
    JNIEnv *, jobject, jlong handle, jboolean vertical, jint delta, jint x, jint y) {
    if (handle == 0) return DVNC_ERR_NULL;
    if (!fits_int16(delta) || !fits_uint16(x) || !fits_uint16(y)) {
        return DVNC_ERR_INVALID_ARGUMENT;
    }
    return dvnc_session_pointer_scroll(
        reinterpret_cast<VncHandlePair *>(handle)->session,
        vertical ? 1 : 0,
        static_cast<int16_t>(delta),
        static_cast<uint16_t>(x),
        static_cast<uint16_t>(y));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeKeyDown(
    JNIEnv *, jobject, jlong handle, jint keysym, jint keycode) {
    if (handle == 0) return DVNC_ERR_NULL;
    if (!is_nonnegative_uint32(keysym) || !is_nonnegative_uint32(keycode)) {
        return DVNC_ERR_INVALID_ARGUMENT;
    }
    return dvnc_session_key_down(
        reinterpret_cast<VncHandlePair *>(handle)->session,
        static_cast<uint32_t>(keysym),
        static_cast<uint32_t>(keycode));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeKeyUp(
    JNIEnv *, jobject, jlong handle, jint keysym, jint keycode) {
    if (handle == 0) return DVNC_ERR_NULL;
    if (!is_nonnegative_uint32(keysym) || !is_nonnegative_uint32(keycode)) {
        return DVNC_ERR_INVALID_ARGUMENT;
    }
    return dvnc_session_key_up(
        reinterpret_cast<VncHandlePair *>(handle)->session,
        static_cast<uint32_t>(keysym),
        static_cast<uint32_t>(keycode));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeSendClipboard(
    JNIEnv *env, jobject, jlong handle, jstring text) {
    if (handle == 0 || text == nullptr) return DVNC_ERR_NULL;
    StandardUtf8Chars chars(env, text);
    if (!chars.valid()) return DVNC_ERR_INVALID_UTF8;
    return dvnc_session_send_clipboard(
        reinterpret_cast<VncHandlePair *>(handle)->session, chars.get());
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRefresh(
    JNIEnv *, jobject, jlong handle) {
    if (handle == 0) return DVNC_ERR_NULL;
    return dvnc_session_refresh(reinterpret_cast<VncHandlePair *>(handle)->session);
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeResize(
    JNIEnv *, jobject, jlong handle, jint width, jint height) {
    if (handle == 0) return DVNC_ERR_NULL;
    if (!fits_positive_uint16(width) || !fits_positive_uint16(height)) {
        return DVNC_ERR_INVALID_ARGUMENT;
    }
    return dvnc_session_request_desktop_size(
        reinterpret_cast<VncHandlePair *>(handle)->session,
        static_cast<uint16_t>(width),
        static_cast<uint16_t>(height));
}

// RDP lifecycle.
JNIEXPORT jlong JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeCreateRdp(
    JNIEnv *env, jobject, jobject callback) {
    JniUserData *user_data = create_user_data(env, callback);
    if (user_data == nullptr) return 0;
    DrdpCallbacks callbacks{};
    callbacks.user_data = user_data;
    callbacks.on_event = on_rdp_event;
    callbacks.on_frame = on_rdp_frame;
    callbacks.on_audio = on_rdp_audio;

    DrdpSessionHandle handle = nullptr;
    if (drdp_session_create(&callbacks, &handle) != DRDP_OK || handle == nullptr) {
        destroy_user_data(env, user_data);
        return 0;
    }
    return reinterpret_cast<jlong>(new RdpHandlePair{handle, user_data});
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeStartRdp(
    JNIEnv *env,
    jobject,
    jlong native_handle,
    jstring host,
    jstring dial_address,
    jstring tunnel_auth_token,
    jint port,
    jstring username,
    jstring password,
    jstring domain,
    jint desktop_width,
    jint desktop_height,
    jboolean audio_enabled,
    jboolean clipboard_enabled,
    jboolean microphone_enabled,
    jboolean camera_enabled,
    jboolean admin_session,
    jint color_depth,
    jstring drives_json) {
    if (native_handle == 0 || host == nullptr) return DRDP_ERR_NULL;
    if (!fits_positive_uint16(port) ||
        !fits_positive_uint16(desktop_width) ||
        !fits_positive_uint16(desktop_height) ||
        !is_color_depth(color_depth)) {
        return DRDP_ERR_INVALID_ARGUMENT;
    }
    auto *pair = reinterpret_cast<RdpHandlePair *>(native_handle);
    StandardUtf8Chars host_chars(env, host);
    StandardUtf8Chars dial_chars(env, dial_address);
    StandardUtf8Chars tunnel_auth_chars(env, tunnel_auth_token);
    StandardUtf8Chars username_chars(env, username);
    StandardUtf8Chars password_chars(env, password);
    StandardUtf8Chars domain_chars(env, domain);
    StandardUtf8Chars drives_chars(env, drives_json);
    if (!host_chars.valid() || !dial_chars.valid() || !tunnel_auth_chars.valid() ||
        !username_chars.valid() || !password_chars.valid() ||
        !domain_chars.valid() || !drives_chars.valid()) {
        return DRDP_ERR_INVALID_UTF8;
    }

    DrdpConnectConfig config{};
    config.host = host_chars.get();
    config.dial_address = dial_chars.get();
    config.tunnel_auth_token = tunnel_auth_chars.get();
    config.port = static_cast<uint16_t>(port);
    config.username = username_chars.get();
    config.password = password_chars.get();
    config.domain = domain_chars.get();
    config.desktop_width = static_cast<uint16_t>(desktop_width);
    config.desktop_height = static_cast<uint16_t>(desktop_height);
    config.audio_enabled = audio_enabled ? 1 : 0;
    config.clipboard_enabled = clipboard_enabled ? 1 : 0;
    config.microphone_enabled = microphone_enabled ? 1 : 0;
    config.camera_enabled = camera_enabled ? 1 : 0;
    config.admin_session = admin_session ? 1 : 0;
    config.color_depth = static_cast<uint8_t>(color_depth);
    config.drives_json = drives_chars.get();
    return drdp_session_start(pair->session, &config);
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeDisconnectRdp(
    JNIEnv *, jobject, jlong handle) {
    if (handle == 0) return DRDP_ERR_NULL;
    return drdp_session_disconnect(reinterpret_cast<RdpHandlePair *>(handle)->session);
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeDestroyRdp(
    JNIEnv *env, jobject, jlong handle) {
    if (handle == 0) return DRDP_ERR_NULL;
    auto *pair = reinterpret_cast<RdpHandlePair *>(handle);
    const int32_t result = drdp_session_destroy(pair->session);
    if (result == DRDP_OK) {
        destroy_user_data(env, pair->user_data);
        delete pair;
    }
    return result;
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpPointerMove(
    JNIEnv *, jobject, jlong handle, jint x, jint y) {
    if (handle == 0) return DRDP_ERR_NULL;
    if (!fits_uint16(x) || !fits_uint16(y)) return DRDP_ERR_INVALID_ARGUMENT;
    return drdp_session_pointer_move(
        reinterpret_cast<RdpHandlePair *>(handle)->session,
        static_cast<uint16_t>(x),
        static_cast<uint16_t>(y));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpPointerButton(
    JNIEnv *, jobject, jlong handle, jint button, jboolean pressed, jint x, jint y) {
    if (handle == 0) return DRDP_ERR_NULL;
    if (!is_pointer_button(button) || !fits_uint16(x) || !fits_uint16(y)) {
        return DRDP_ERR_INVALID_ARGUMENT;
    }
    return drdp_session_pointer_button(
        reinterpret_cast<RdpHandlePair *>(handle)->session,
        static_cast<uint8_t>(button),
        pressed ? 1 : 0,
        static_cast<uint16_t>(x),
        static_cast<uint16_t>(y));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpPointerScroll(
    JNIEnv *, jobject, jlong handle, jboolean vertical, jint delta, jint x, jint y) {
    if (handle == 0) return DRDP_ERR_NULL;
    if (!fits_int16(delta) || !fits_uint16(x) || !fits_uint16(y)) {
        return DRDP_ERR_INVALID_ARGUMENT;
    }
    return drdp_session_pointer_scroll(
        reinterpret_cast<RdpHandlePair *>(handle)->session,
        vertical ? 1 : 0,
        static_cast<int16_t>(delta),
        static_cast<uint16_t>(x),
        static_cast<uint16_t>(y));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpKey(
    JNIEnv *, jobject, jlong handle, jint scancode, jboolean pressed) {
    if (handle == 0) return DRDP_ERR_NULL;
    if (!fits_positive_uint16(scancode)) return DRDP_ERR_INVALID_ARGUMENT;
    return drdp_session_key(
        reinterpret_cast<RdpHandlePair *>(handle)->session,
        static_cast<uint16_t>(scancode),
        pressed ? 1 : 0);
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpUnicode(
    JNIEnv *, jobject, jlong handle, jint codepoint, jboolean pressed) {
    if (handle == 0) return DRDP_ERR_NULL;
    if (!is_unicode_scalar(codepoint)) return DRDP_ERR_INVALID_ARGUMENT;
    return drdp_session_unicode(
        reinterpret_cast<RdpHandlePair *>(handle)->session,
        static_cast<uint32_t>(codepoint),
        pressed ? 1 : 0);
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpSendClipboard(
    JNIEnv *env, jobject, jlong handle, jstring text) {
    if (handle == 0 || text == nullptr) return DRDP_ERR_NULL;
    StandardUtf8Chars chars(env, text);
    if (!chars.valid()) return DRDP_ERR_INVALID_UTF8;
    return drdp_session_send_clipboard(
        reinterpret_cast<RdpHandlePair *>(handle)->session, chars.get());
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpRefresh(
    JNIEnv *, jobject, jlong handle) {
    if (handle == 0) return DRDP_ERR_NULL;
    return drdp_session_refresh(reinterpret_cast<RdpHandlePair *>(handle)->session);
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpResize(
    JNIEnv *, jobject, jlong handle, jint width, jint height) {
    if (handle == 0) return DRDP_ERR_NULL;
    if (!fits_positive_uint16(width) || !fits_positive_uint16(height)) {
        return DRDP_ERR_INVALID_ARGUMENT;
    }
    return drdp_session_resize(
        reinterpret_cast<RdpHandlePair *>(handle)->session,
        static_cast<uint16_t>(width),
        static_cast<uint16_t>(height));
}

JNIEXPORT jint JNICALL
Java_com_dolssh_remotedesktop_RemoteDesktopSessionManager_nativeRdpTrustCertificate(
    JNIEnv *, jobject, jlong handle, jboolean accept) {
    if (handle == 0) return DRDP_ERR_NULL;
    return drdp_session_trust_certificate(
        reinterpret_cast<RdpHandlePair *>(handle)->session,
        accept ? 1 : 0);
}

}  // extern "C"
