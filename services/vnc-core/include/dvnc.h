/**
 * @file dvnc.h
 * @brief Dolgate VNC Core — C ABI for iOS/Android mobile bindings.
 *
 * This header declares the full public C API surface of the vnc-core library.
 *
 * ## Handle lifetime
 *
 * - dvnc_session_create() → opaque handle (process-local token). Caller owns it.
 * - dvnc_session_start()  → spawns worker thread, connects to VNC server.
 * - dvnc_session_disconnect() → requests async teardown. Wait for on_closed callback.
 * - dvnc_session_destroy() → releases the handle. Joins worker. Handle is invalid after.
 *
 * The opaque handle is a monotonic token cast to `void*`. It is NEVER dereferenced.
 * An internal registry maps tokens to sessions. After destroy, any call with the
 * same token returns DVNC_ERR_INVALID_HANDLE. Double-destroy and concurrent destroy
 * are safe (not UB).
 *
 * ## Thread safety
 *
 * All dvnc_session_* functions are safe to call from any thread on the same handle.
 * Internal Mutex protects the registry and session state.
 *
 * ## Callback lifetime
 *
 * - Frame/cursor pixel pointers are valid ONLY during the callback invocation.
 *   Copy or submit to GPU before returning.
 * - String pointers (name, text, json, message) are null-terminated UTF-8,
 *   valid only during the callback invocation.
 * - Callbacks are invoked on the worker thread.
 * - After on_closed fires, no more callbacks arrive for that session.
 *
 * ## user_data contract
 *
 * user_data is an opaque pointer owned by the caller. Rust never frees it.
 * It is passed to every callback unchanged. The caller must free it after
 * dvnc_session_destroy() returns (or any time they choose — Rust doesn't touch it).
 *
 * ## Callback failure policy
 *
 * All callbacks return void. If renderer fails internally (e.g. texture upload),
 * the Rust session continues running. To tear down the session from a callback,
 * call dvnc_session_disconnect() from another thread.
 */

#ifndef DVNC_H
#define DVNC_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ══════════════════════════════════════════════════════════════════════
 * Error codes
 * ══════════════════════════════════════════════════════════════════════ */

/** Success. */
#define DVNC_OK                    0
/** A required pointer argument was NULL. */
#define DVNC_ERR_NULL             (-1)
/** A string argument was not valid UTF-8. */
#define DVNC_ERR_INVALID_UTF8     (-2)
/** Session was already started (dvnc_session_start called twice). */
#define DVNC_ERR_ALREADY_STARTED  (-3)
/** Handle is invalid (already destroyed, or never existed). */
#define DVNC_ERR_INVALID_HANDLE   (-4)
/** A numeric or enum argument is outside its supported range. */
#define DVNC_ERR_INVALID_ARGUMENT (-6)
/** Internal error (thread spawn failed, mutex poisoned, channel broken). */
#define DVNC_ERR_INTERNAL         (-5)
/**
 * dvnc_session_destroy was called from a worker callback thread. Shutdown was requested and
 * the session is still owned by the library: retry destroy from another thread and do NOT
 * release user_data until a call returns DVNC_OK.
 */
#define DVNC_ERR_CALLBACK_THREAD  (-7)
/** A Rust panic was caught at the FFI boundary. */
#define DVNC_ERR_PANIC            (-99)

/* ══════════════════════════════════════════════════════════════════════
 * Opaque handle
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Opaque session handle.
 *
 * This is a process-local monotonic token cast to void*. It is NEVER
 * dereferenced as a pointer. Treat it as an opaque identifier.
 */
typedef void* DvncSessionHandle;

/* ══════════════════════════════════════════════════════════════════════
 * Callback function types
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Connection success. `name` is null-terminated UTF-8, valid during callback only.
 */
typedef void (*DvncOnConnected)(
    void* user_data,
    uint16_t desktop_width,
    uint16_t desktop_height,
    const char* name
);

/** Desktop resize. */
typedef void (*DvncOnResized)(
    void* user_data,
    uint16_t desktop_width,
    uint16_t desktop_height
);

/**
 * Capabilities changed (JSON payload).
 * `json` is null-terminated UTF-8, valid during callback only.
 */
typedef void (*DvncOnCapabilities)(void* user_data, const char* json);

/**
 * Clipboard text received from remote.
 * `text` is null-terminated UTF-8, valid during callback only.
 */
typedef void (*DvncOnClipboard)(void* user_data, const char* text);

/**
 * Error. `message` is null-terminated UTF-8, valid during callback only.
 */
typedef void (*DvncOnError)(void* user_data, const char* message);

/** Session closed. No more callbacks after this. */
typedef void (*DvncOnClosed)(void* user_data);

/**
 * RGBA frame update.
 * `pixels` points to width*height*4 bytes. Valid during callback ONLY.
 */
typedef void (*DvncOnFrame)(
    void* user_data,
    uint16_t x,
    uint16_t y,
    uint16_t width,
    uint16_t height,
    const uint8_t* pixels,
    uint32_t pixels_len
);

/**
 * Cursor shape update.
 * `rgba` points to width*height*4 bytes. Valid during callback ONLY.
 * width=0 && height=0 means "hide cursor".
 */
typedef void (*DvncOnCursor)(
    void* user_data,
    uint16_t hotspot_x,
    uint16_t hotspot_y,
    uint16_t width,
    uint16_t height,
    const uint8_t* rgba,
    uint32_t rgba_len
);

/* ══════════════════════════════════════════════════════════════════════
 * Callback table
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Callback table. All callbacks fire on the worker thread.
 * NULL callbacks are silently skipped (optional).
 * user_data is passed to every callback unchanged.
 */
typedef struct DvncCallbacks {
    void*              user_data;
    DvncOnConnected    on_connected;   /* may be NULL */
    DvncOnResized      on_resized;     /* may be NULL */
    DvncOnCapabilities on_capabilities;/* may be NULL */
    DvncOnClipboard    on_clipboard;   /* may be NULL */
    DvncOnError        on_error;       /* may be NULL */
    DvncOnClosed       on_closed;      /* may be NULL */
    DvncOnFrame        on_frame;       /* may be NULL */
    DvncOnCursor       on_cursor;      /* may be NULL */
} DvncCallbacks;

/* ══════════════════════════════════════════════════════════════════════
 * Connect configuration
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Connection configuration. Fill from C and pass to dvnc_session_start.
 */
typedef struct DvncConnectConfig {
    /** Hostname. Null-terminated UTF-8. Must not be NULL or empty. */
    const char* host;
    /** Port. 0 defaults to 5900. */
    uint16_t port;
    /** Password. Null-terminated UTF-8. NULL = empty string. */
    const char* password;
    /** Username (VeNCrypt Plain). Null-terminated UTF-8. NULL = empty. */
    const char* username;
    /** Image quality: "lossless", "balanced", "fast". NULL = lossless. */
    const char* image_quality;
    /** Share with other clients: 0=exclusive, 1=shared. */
    uint8_t shared;
    /** Optional 64-character tunnel token; NULL/empty means direct TCP. */
    const char* tunnel_auth_token;
} DvncConnectConfig;

/* ══════════════════════════════════════════════════════════════════════
 * API functions
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Create a new session.
 *
 * @param callbacks  Pointer to a filled DvncCallbacks struct. Must not be NULL.
 * @param out_handle Receives the opaque handle on success (NULL on error).
 * @return DVNC_OK on success, DVNC_ERR_NULL if callbacks or out_handle is NULL.
 */
int32_t dvnc_session_create(
    const DvncCallbacks* callbacks,
    DvncSessionHandle* out_handle
);

/**
 * Start the session (spawn worker, connect to VNC server).
 *
 * Does not block until connection completes. The result is delivered
 * asynchronously via on_connected or on_error callbacks.
 *
 * @param handle Valid session handle from dvnc_session_create.
 * @param config Connection configuration. Must not be NULL.
 * @return DVNC_OK, DVNC_ERR_NULL, DVNC_ERR_ALREADY_STARTED, DVNC_ERR_INVALID_HANDLE.
 */
int32_t dvnc_session_start(
    DvncSessionHandle handle,
    const DvncConnectConfig* config
);

/**
 * Request disconnect (async).
 * Wait for on_closed callback before calling destroy.
 * Safe to call on non-started or already-disconnected sessions (no-op).
 */
int32_t dvnc_session_disconnect(DvncSessionHandle handle);

/**
 * Destroy the session handle.
 * Joins the worker thread, then removes from registry.
 * After this call the handle is invalid.
 * Double-destroy returns DVNC_ERR_INVALID_HANDLE (not UB).
 */
int32_t dvnc_session_destroy(DvncSessionHandle handle);

/** Send pointer move event. */
int32_t dvnc_session_pointer_move(DvncSessionHandle handle, uint16_t x, uint16_t y);

/**
 * Send pointer button event.
 * @param button 0=left, 1=middle, 2=right.
 * @param pressed 0=released, nonzero=pressed.
 */
int32_t dvnc_session_pointer_button(
    DvncSessionHandle handle,
    uint8_t button,
    uint8_t pressed,
    uint16_t x,
    uint16_t y
);

/**
 * Send scroll event.
 * @param vertical 0=horizontal, 1=vertical.
 * @param delta positive=up/right.
 */
int32_t dvnc_session_pointer_scroll(
    DvncSessionHandle handle,
    uint8_t vertical,
    int16_t delta,
    uint16_t x,
    uint16_t y
);

/** Send key down. keysym=X11 keysym, keycode=PS/2 scancode (0=ignore). */
int32_t dvnc_session_key_down(DvncSessionHandle handle, uint32_t keysym, uint32_t keycode);

/** Send key up. */
int32_t dvnc_session_key_up(DvncSessionHandle handle, uint32_t keysym, uint32_t keycode);

/**
 * Send clipboard text to remote.
 * @param text Null-terminated UTF-8. Must not be NULL.
 */
int32_t dvnc_session_send_clipboard(DvncSessionHandle handle, const char* text);

/** Request full screen refresh (for corruption recovery). */
int32_t dvnc_session_refresh(DvncSessionHandle handle);

/** Request remote desktop resize. Server may silently ignore. */
int32_t dvnc_session_request_desktop_size(
    DvncSessionHandle handle,
    uint16_t width,
    uint16_t height
);

/* ══════════════════════════════════════════════════════════════════════
 * Static assertions (compile-time ABI checks)
 * ══════════════════════════════════════════════════════════════════════ */

#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#include <assert.h>
/* Ensure callback table has expected layout (no padding surprises). */
_Static_assert(
    sizeof(DvncCallbacks) == sizeof(void*) * 9,
    "DvncCallbacks must be 9 pointers (user_data + 8 callbacks)"
);
/* Ensure handle is pointer-sized. */
_Static_assert(
    sizeof(DvncSessionHandle) == sizeof(void*),
    "DvncSessionHandle must be pointer-sized"
);
#endif

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* DVNC_H */
