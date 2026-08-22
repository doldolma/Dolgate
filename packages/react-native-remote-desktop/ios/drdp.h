#ifndef DRDP_H
#define DRDP_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DRDP_OK 0
#define DRDP_ERR_NULL -1
#define DRDP_ERR_INVALID_UTF8 -2
#define DRDP_ERR_ALREADY_STARTED -3
#define DRDP_ERR_INVALID_HANDLE -4
#define DRDP_ERR_INTERNAL -5
#define DRDP_ERR_INVALID_ARGUMENT -6
#define DRDP_ERR_CALLBACK_THREAD -7
#define DRDP_ERR_PANIC -99

typedef void *DrdpSessionHandle;

typedef void (*DrdpOnEvent)(void *user_data,
                            const uint8_t *json,
                            uint32_t json_len);
typedef void (*DrdpOnFrame)(void *user_data,
                            uint16_t x,
                            uint16_t y,
                            uint16_t width,
                            uint16_t height,
                            const uint8_t *pixels,
                            uint32_t pixels_len);
typedef void (*DrdpOnAudio)(void *user_data,
                            uint32_t sample_rate,
                            uint16_t channels,
                            uint16_t bits_per_sample,
                            uint32_t timestamp,
                            const uint8_t *samples,
                            uint32_t samples_len);

typedef struct {
    void *user_data;
    DrdpOnEvent on_event;
    DrdpOnFrame on_frame;
    DrdpOnAudio on_audio;
} DrdpCallbacks;

typedef struct {
    const char *host;
    const char *dial_address;
    uint16_t port;
    const char *username;
    const char *password;
    const char *domain;
    uint16_t desktop_width;
    uint16_t desktop_height;
    uint8_t audio_enabled;
    uint8_t clipboard_enabled;
    uint8_t microphone_enabled;
    uint8_t camera_enabled;
    uint8_t admin_session;
    uint8_t color_depth;
    const char *drives_json;
    const char *tunnel_auth_token;
} DrdpConnectConfig;

int32_t drdp_session_create(const DrdpCallbacks *callbacks,
                            DrdpSessionHandle *out_handle);
int32_t drdp_session_start(DrdpSessionHandle handle,
                           const DrdpConnectConfig *config);
int32_t drdp_session_disconnect(DrdpSessionHandle handle);
int32_t drdp_session_destroy(DrdpSessionHandle handle);
int32_t drdp_session_pointer_move(DrdpSessionHandle handle,
                                  uint16_t x,
                                  uint16_t y);
int32_t drdp_session_pointer_button(DrdpSessionHandle handle,
                                    uint8_t button,
                                    uint8_t pressed,
                                    uint16_t x,
                                    uint16_t y);
int32_t drdp_session_pointer_scroll(DrdpSessionHandle handle,
                                    uint8_t vertical,
                                    int16_t delta,
                                    uint16_t x,
                                    uint16_t y);
int32_t drdp_session_key(DrdpSessionHandle handle,
                         uint16_t scancode,
                         uint8_t pressed);
int32_t drdp_session_unicode(DrdpSessionHandle handle,
                             uint32_t codepoint,
                             uint8_t pressed);
int32_t drdp_session_resize(DrdpSessionHandle handle,
                            uint16_t width,
                            uint16_t height);
int32_t drdp_session_refresh(DrdpSessionHandle handle);
int32_t drdp_session_trust_certificate(DrdpSessionHandle handle,
                                       uint8_t accept);
int32_t drdp_session_send_clipboard(DrdpSessionHandle handle,
                                    const char *text);
int32_t drdp_session_send_microphone(DrdpSessionHandle handle,
                                     const uint8_t *samples,
                                     uint32_t samples_len);
int32_t drdp_session_send_camera(DrdpSessionHandle handle,
                                 const uint8_t *frame,
                                 uint32_t frame_len);

#ifdef __cplusplus
}
#endif

#endif /* DRDP_H */
