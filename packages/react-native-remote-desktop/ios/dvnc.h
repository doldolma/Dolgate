/**
 * dvnc.h — Public C interface for the vnc-core Rust static library FFI.
 *
 * This file mirrors the public C ABI declared in services/vnc-core/src/ffi.rs.
 * Once services/vnc-core/include/dvnc.h is generated (e.g. via cbindgen), this
 * file should be replaced by a reference to that canonical header.
 *
 * Thread safety: all dvnc_session_* functions are safe to call from any thread
 * for a given handle. Callbacks fire on the Rust worker thread.
 *
 * Pointer lifetime: frame/cursor pixel pointers are valid ONLY during the
 * callback invocation. Callers must copy within the callback body.
 */

#ifndef DVNC_H
#define DVNC_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── Error Codes ─────────────────────────────────────────────────────

#define DVNC_OK                  0
#define DVNC_ERR_NULL           -1
#define DVNC_ERR_INVALID_UTF8   -2
#define DVNC_ERR_ALREADY_STARTED -3
#define DVNC_ERR_INVALID_HANDLE -4
#define DVNC_ERR_INVALID_ARGUMENT -6
#define DVNC_ERR_INTERNAL       -5
#define DVNC_ERR_CALLBACK_THREAD -7
#define DVNC_ERR_PANIC          -99

// ── Opaque Handle ───────────────────────────────────────────────────

typedef void *DvncSessionHandle;

// ── Callback Types ──────────────────────────────────────────────────

typedef void (*DvncOnConnected)(void *user_data,
                                uint16_t desktop_width,
                                uint16_t desktop_height,
                                const char *name);

typedef void (*DvncOnResized)(void *user_data,
                              uint16_t desktop_width,
                              uint16_t desktop_height);

typedef void (*DvncOnCapabilities)(void *user_data, const char *json);

typedef void (*DvncOnClipboard)(void *user_data, const char *text);

typedef void (*DvncOnError)(void *user_data, const char *message);

typedef void (*DvncOnClosed)(void *user_data);

typedef void (*DvncOnFrame)(void *user_data,
                            uint16_t x, uint16_t y,
                            uint16_t width, uint16_t height,
                            const uint8_t *pixels,
                            uint32_t pixels_len);

typedef void (*DvncOnCursor)(void *user_data,
                             uint16_t hotspot_x, uint16_t hotspot_y,
                             uint16_t width, uint16_t height,
                             const uint8_t *rgba,
                             uint32_t rgba_len);

// ── Callback Table ──────────────────────────────────────────────────

typedef struct {
    void *user_data;
    DvncOnConnected  on_connected;
    DvncOnResized    on_resized;
    DvncOnCapabilities on_capabilities;
    DvncOnClipboard  on_clipboard;
    DvncOnError      on_error;
    DvncOnClosed     on_closed;
    DvncOnFrame      on_frame;
    DvncOnCursor     on_cursor;
} DvncCallbacks;

// ── Connect Config ──────────────────────────────────────────────────

typedef struct {
    const char *host;
    uint16_t    port;
    const char *password;
    const char *username;
    const char *image_quality;
    uint8_t     shared;
    const char *tunnel_auth_token;
} DvncConnectConfig;

// ── Session API ─────────────────────────────────────────────────────

int32_t dvnc_session_create(const DvncCallbacks *callbacks,
                            DvncSessionHandle *out_handle);

int32_t dvnc_session_start(DvncSessionHandle handle,
                           const DvncConnectConfig *config);

int32_t dvnc_session_disconnect(DvncSessionHandle handle);

int32_t dvnc_session_destroy(DvncSessionHandle handle);

// ── Input API ───────────────────────────────────────────────────────

int32_t dvnc_session_pointer_move(DvncSessionHandle handle,
                                  uint16_t x, uint16_t y);

int32_t dvnc_session_pointer_button(DvncSessionHandle handle,
                                    uint8_t button, uint8_t pressed,
                                    uint16_t x, uint16_t y);

int32_t dvnc_session_pointer_scroll(DvncSessionHandle handle,
                                    uint8_t vertical, int16_t delta,
                                    uint16_t x, uint16_t y);

int32_t dvnc_session_key_down(DvncSessionHandle handle,
                              uint32_t keysym, uint32_t keycode);

int32_t dvnc_session_key_up(DvncSessionHandle handle,
                            uint32_t keysym, uint32_t keycode);

// ── Clipboard / Control ─────────────────────────────────────────────

int32_t dvnc_session_send_clipboard(DvncSessionHandle handle,
                                    const char *text);

int32_t dvnc_session_refresh(DvncSessionHandle handle);

int32_t dvnc_session_request_desktop_size(DvncSessionHandle handle,
                                          uint16_t width, uint16_t height);

#ifdef __cplusplus
}
#endif

#endif /* DVNC_H */
