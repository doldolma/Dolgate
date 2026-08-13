#!/bin/bash
# MODE 하나를 띄운다. 인증·암호화 조합이 모드마다 다르다.
#
#   MODE=tiger-tlsvnc PORT=5904 VNC_PW=123123 /start.sh
#
# 화면에 xterm 을 하나 띄우는 이유는 두 가지다: 화면이 전부 단색이면 인코딩 경로가 거의 타지
# 않고(픽셀 검증이 무의미해진다), 클립보드 검증에는 X 클라이언트가 하나는 떠 있어야 한다.
set -eu

GEOM="${GEOM:-1024x768}"
PORT="${PORT:?PORT is required}"
PW="${VNC_PW:-123123}"
USER_NAME="${VNC_USER:-ubuntu}"

mkpass() { printf '%s' "$PW" | tigervncpasswd -f > /tmp/pw; chmod 600 /tmp/pw; }

mkcert() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -subj "/CN=vnc-test" -keyout /tmp/key.pem -out /tmp/cert.pem >/dev/null 2>&1
  chmod 600 /tmp/key.pem
}

# 화면에 창 하나를 띄운다. **실패해도 무시한다** — TightVNC 의 옛 Xvnc 처럼 Xft 를 못 쓰는
# 서버에서는 xterm 이 바로 죽는데, 그것 때문에 서버를 못 띄우면 안 된다(화면 검증은 빈 루트
# 화면으로도 성립한다).
filler() {  # filler <display> <설명>
  DISPLAY="$1" xterm -geometry 90x24+20+20 -fa 'DejaVu Sans Mono' -fs 14 \
    -e bash -c "echo; echo '  $2'; echo; exec bash" >/dev/null 2>&1 &
  sleep 1
}

# 띄운 서버의 PID. 스크립트 끝에서 **이것만** 기다린다.
#
# 예전에는 `wait -n` 이었는데, 그러면 xterm 이 먼저 죽는 순간 스크립트가 끝나고 컨테이너가
# 내려간다 — TightVNC 모드가 정확히 그래서 "연결 거부" 로 보였다.
server_pid=""

tiger() {  # tiger <SecurityTypes> [추가 인자...]
  local sec="$1"; shift
  Xtigervnc :1 -geometry "$GEOM" -depth 24 -rfbport "$PORT" \
    -SecurityTypes "$sec" -localhost=0 "$@" &
  server_pid=$!
  sleep 2
  filler :1 "$MODE  port $PORT"
}

case "${MODE:?MODE is required}" in
  tiger-none)      tiger None ;;
  tiger-vncauth)   mkpass; tiger VncAuth -PasswordFile /tmp/pw ;;
  tiger-tlsnone)   tiger TLSNone ;;
  tiger-tlsvnc)    mkpass; tiger TLSVnc -PasswordFile /tmp/pw ;;
  tiger-x509none)  mkcert; tiger X509None -X509Cert /tmp/cert.pem -X509Key /tmp/key.pem ;;
  tiger-x509vnc)   mkpass; mkcert; tiger X509Vnc -PasswordFile /tmp/pw \
                     -X509Cert /tmp/cert.pem -X509Key /tmp/key.pem ;;
  tiger-tlsplain)
    # PAM 으로 계정을 검사한다 — 컨테이너 안 계정에 비밀번호를 심어 둔다.
    echo "$USER_NAME:$PW" | chpasswd
    tiger TLSPlain -PlainUsers "$USER_NAME" -PAMService login
    ;;
  x11vnc-none|x11vnc-vncauth)
    Xvfb :2 -screen 0 "${GEOM}x24" &
    sleep 2
    filler :2 "$MODE  port $PORT"
    args=(-display :2 -rfbport "$PORT" -forever -shared -noxdamage -quiet)
    [ "$MODE" = "x11vnc-vncauth" ] && args+=(-passwd "$PW")
    exec x11vnc "${args[@]}"
    ;;
  tightvnc-vncauth)
    # TightVNC 의 Xvnc — 다른 구현체이고 옛 프로토콜(RFB 3.3/3.7)을 말한다.
    mkdir -p /root/.vnc
    printf '%s' "$PW" | vncpasswd -f > /root/.vnc/passwd
    chmod 600 /root/.vnc/passwd
    # **`Xvnc` 가 아니라 `Xtightvnc` 를 부른다.** 두 패키지가 모두 `Xvnc` 대안을 등록해서
    # `Xvnc` 는 TigerVNC 로 연결된다 — 그대로 두면 TigerVNC 를 두 번 검증하면서 TightVNC 를
    # 검증했다고 착각한다(실측으로 그랬다).
    # TightVNC 의 Xvnc 는 `-localhost` 옵션이 없다(TigerVNC 전용이다). 기본이 모든 인터페이스라
    # 그대로 두면 된다.
    USER=root HOME=/root Xtightvnc :3 -geometry "$GEOM" -depth 24 -rfbport "$PORT" \
      -rfbauth /root/.vnc/passwd &
    server_pid=$!
    sleep 2
    filler :3 "$MODE  port $PORT"
    ;;
  qemu-none)
    # QEMU 내장 VNC. libvirt·QEMU 콘솔이 이 서버이고, 관행상 localhost 에만 열려서 우리 SSH
    # 터널 경로의 주 대상이다. X 서버가 없어 클립보드 검증 대상은 아니다(clipboard=none).
    exec qemu-system-x86_64 -m 128 -nodefaults -vga std \
      -display "vnc=0.0.0.0:$((PORT - 5900))"
    ;;
  qemu-vncauth)
    exec qemu-system-x86_64 -m 128 -nodefaults -vga std \
      -object "secret,id=sec0,data=$PW" \
      -display "vnc=0.0.0.0:$((PORT - 5900)),password-secret=sec0"
    ;;
  *) echo "unknown MODE: $MODE" >&2; exit 1 ;;
esac

# 띄운 서버가 죽으면 컨테이너도 내려간다. xterm 이 죽는 것은 무시한다(위 filler 주석 참고).
wait "$server_pid"
