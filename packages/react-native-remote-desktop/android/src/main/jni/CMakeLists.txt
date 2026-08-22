cmake_minimum_required(VERSION 3.22.1)
project(dvnc_jni LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# --- Rust cdylibs (prebuilt per ABI by Gradle) ---
set(RUST_JNI_LIBS_DIR "${CMAKE_SOURCE_DIR}/../../../build/rustJniLibs/${ANDROID_ABI}")

add_library(vnc_core SHARED IMPORTED)
set_target_properties(vnc_core PROPERTIES
    IMPORTED_LOCATION "${RUST_JNI_LIBS_DIR}/libvnc_core.so"
    IMPORTED_NO_SONAME TRUE
)

add_library(rdp_core SHARED IMPORTED)
set_target_properties(rdp_core PROPERTIES
    IMPORTED_LOCATION "${RUST_JNI_LIBS_DIR}/librdp_core.so"
    IMPORTED_NO_SONAME TRUE
)

# --- JNI bridge ---
add_library(dvnc_jni SHARED
    dvnc_jni.cpp
)

# 16KB 페이지 기기에서 로드되게 세그먼트를 16KB 경계에 맞춘다.
#
# 안드로이드는 오래도록 4KB 페이지였고 NDK 기본값도 그렇다. 최근 ARM64 기기는 16KB 페이지로
# 동작할 수 있는데, 그런 기기에서는 LOAD 세그먼트가 16KB 에 맞지 않은 .so 를 커널이 매핑하지
# 못해 dlopen 이 실패한다 — 앱이 RDP/VNC 세션을 여는 순간 죽는다. 확인은
# `llvm-readelf -lW libdvnc_jni.so` 의 LOAD Align 이 0x4000 인지 보면 된다.
target_link_options(dvnc_jni PRIVATE "-Wl,-z,max-page-size=16384")

target_include_directories(dvnc_jni PRIVATE
    ${CMAKE_SOURCE_DIR}
)

# liblog 만 필요하다(LOGE). **GLESv2·EGL·libandroid 는 링크하지 않는다** — 이 브릿지는
# 렌더링을 하지 않는다. 화면은 Kotlin 쪽 RemoteDesktopTextureView 가 GLES20 과
# javax.microedition.khronos.egl 로 그리고, C++ 은 프레임 바이트를 넘기는 일만 한다.
# 여기에 GL 을 링크해 두면 읽는 사람이 렌더링 위치를 반대로 짚는다.
find_library(log-lib log)

target_link_libraries(dvnc_jni
    vnc_core
    rdp_core
    ${log-lib}
)
