#!/bin/bash
# 실서버 호환성 검증. 구현체·인증·암호화 조합을 하나씩 띄우고 vnc-probe 로 붙어 본다.
#
#   ./build.sh && ./matrix.sh                 전체
#   ./matrix.sh tiger-none x11vnc-none        일부만
#   HOLD=30 ./matrix.sh                       세션을 더 오래 붙잡는다
#
# **화면이 왔는지만 보지 않는다.** 확장 클립보드 결함 네 건 중 세 건이 "연결되고 화면도 오는데
# 클립보드가 안 되는" 종류였고, 화면만 보던 검증은 그것들을 전부 통과시켰다. 그래서 이 스크립트는
# 세 가지를 본다:
#
#   1. 화면    — 사각형이 오고 프레임버퍼가 채워지는가
#   2. 유지    — 클립보드를 여러 번 보낸 뒤에도 세션이 살아 있는가(끊김이 이 결함들의 증상이었다)
#   3. 클립보드 — **서버 안에서 값을 실제로 읽어** 우리가 보낸 것과 같은가, 그리고 서버가 복사한
#                것이 우리에게 들어오는가
#
# 3번이 이 스크립트의 존재 이유다. 없으면 "안 끊기니 통과" 로 끝나고, 정작 붙여넣기가 안 된다.
#
# **이 검사가 실제로 결함을 잡는지 확인해 두었다.** 고친 코드를 다시 망가뜨려 각 결함이 어디서
# 걸리는지 확인한 결과다(같은 방식으로 다시 해볼 수 있다):
#
#   결함                                  걸리는 자리
#   ────────────────────────────────────  ──────────────────────────────────────────────
#   의사 인코딩 번호를 틀리게(-1063)      matrix tiger-none: 붙여넣기값이 latin1 로 떨어진다
#   동작 비트 표를 한 칸 밀기             matrix tiger-none: 붙여넣기 없음 + 원격 복사 없음
#   zlib 스트림을 finish() 로 완결        matrix x11vnc-none: 서버가 끊는다(화면·유지 실패)
#   notify 를 건너뛰고 provide 만         cargo test: announces_with_notify_then_provides_on_request
#
# 마지막 것은 실서버로는 안 걸린다 — 고전 메시지가 announce 를 겸해서 TigerVNC 에서는 값이
# 그래도 들어온다. 프로토콜 순서 자체는 Rust 통합 테스트가 지킨다. **두 층이 같이 있어야 한다.**
#
# 실패가 하나라도 있으면 종료 코드가 1 이다.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
IMG=dolgate-vnc-testing:latest
HOLD="${HOLD:-30}"
PW=123123
PROBE="${PROBE:-$HERE/../target/debug/vnc-probe}"
SENT_TEXT='한글 clipboard abc'
# **같은 텍스트를 여러 번 보낸다.** 두 가지를 한 번에 본다:
#
#   - x11vnc 는 선택 영역 창(selwin)을 **접속 10초 뒤에** 만든다(실측 로그: `created selwin`).
#     그 전에 보낸 것은 받을 자리가 없어 사라진다 — 한 번만 보내면 이 구현이 늘 실패로 보인다.
#   - 반복 전송 자체가 회귀 지점이었다. zlib 스트림을 끝내 보내던 시절 두 번째 전송에서 세션이
#     죽었다.
CLIP_REPEATS=8
# 고전(latin-1) 경로로 나가면 한글이 `?` 로 바뀐다. 그 서버들의 기대값이다.
SENT_TEXT_LATIN1='?? clipboard abc'
REMOTE_TEXT='원격에서 복사한 값'

if [ ! -x "$PROBE" ]; then
  echo "vnc-probe 가 없다. 먼저: cd services/vnc-core && cargo build --bin vnc-probe" >&2
  exit 2
fi

# mode:port:비밀번호:계정:디스플레이:클립보드기대:설명
#
# 클립보드 기대값의 뜻:
#
#   utf8   — **게이트다.** 확장 클립보드로 보낸 값이 서버 안에서 그대로 읽혀야 하고, 서버가 복사한
#            것도 우리에게 들어와야 한다. 안 되면 실패로 센다. 확장 클립보드 결함 네 건이 모두 이
#            구현(TigerVNC)에서 드러났고, 사용자 서버도 이것이다
#   report — **관측만 한다.** 값을 읽어 표에 적지만 실패로 세지 않는다. x11vnc·TightVNC 는 헤드리스
#            컨테이너에서 선택 영역 동작이 결정적이지 않다: x11vnc 는 선택 영역 창(selwin)을 접속
#            10초 뒤에 만들고(실측 로그 `created selwin`), 값이 첫 접속에서는 안 들어오고 두 번째
#            접속부터 들어온다. 이걸 게이트로 두면 코드가 멀쩡할 때도 빨간불이 켜져서, 정작 진짜
#            회귀가 났을 때 아무도 안 본다
#   none   — X 서버가 없어 읽을 수 없다(QEMU). 화면·유지만 본다
ALL_MODES=(
  "tiger-none:5911:::1:utf8:TigerVNC 인증 없음"
  "tiger-vncauth:5912:$PW::1:utf8:TigerVNC VncAuth(DES)"
  "tiger-tlsnone:5913:::1:utf8:TigerVNC VeNCrypt TLSNone(익명 TLS)"
  "tiger-tlsvnc:5914:$PW::1:utf8:TigerVNC VeNCrypt TLSVnc"
  "tiger-x509none:5915:::1:utf8:TigerVNC VeNCrypt X509None(인증서 TLS)"
  "tiger-x509vnc:5916:$PW::1:utf8:TigerVNC VeNCrypt X509Vnc"
  "tiger-tlsplain:5917:$PW:ubuntu:1:utf8:TigerVNC VeNCrypt TLSPlain(계정)"
  "x11vnc-none:5918:::2:report:x11vnc 인증 없음"
  "x11vnc-vncauth:5919:$PW::2:report:x11vnc VncAuth"
  "tightvnc-vncauth:5920:$PW::3:report:TightVNC Xvnc VncAuth"
  "qemu-none:5921::::none:QEMU 콘솔 인증 없음"
  "qemu-vncauth:5922:$PW:::none:QEMU 콘솔 VncAuth"
)

MODES=()
if [ "$#" -gt 0 ]; then
  for want in "$@"; do
    for entry in "${ALL_MODES[@]}"; do
      [ "${entry%%:*}" = "$want" ] && MODES+=("$entry")
    done
  done
  [ "${#MODES[@]}" -gt 0 ] || { echo "모르는 모드: $*" >&2; exit 2; }
else
  MODES=("${ALL_MODES[@]}")
fi

cleanup() { for e in "${MODES[@]}"; do docker rm -f "vt-${e%%:*}" >/dev/null 2>&1; done; }
trap cleanup EXIT

failures=0
printf '%-34s %-6s %-6s %-9s %-9s %s\n' 서버·인증 화면 유지 붙여넣기 원격복사 비고
printf '%s\n' "────────────────────────────────────────────────────────────────────────────────────────"

for entry in "${MODES[@]}"; do
  IFS=: read -r mode port pw user disp expect desc <<< "$entry"
  name="vt-$mode"
  log="/tmp/vnc-matrix-$mode.log"

  # 한 번에 하나만 띄운다 — 12개를 동시에 띄우면 도커가 메모리로 죽는다(실측: exit 137).
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --rm --name "$name" -e MODE="$mode" -e PORT="$port" -e VNC_PW="$PW" \
    -p "$port:$port" "$IMG" >/dev/null 2>&1
  sleep 7

  clip_list="$SENT_TEXT"
  for _ in $(seq 2 "$CLIP_REPEATS"); do clip_list="$clip_list,$SENT_TEXT"; done
  ( VNC_PROBE_USER="$user" VNC_PROBE_HOLD_SECS="$HOLD" VNC_PROBE_CLIP="$clip_list" \
    DOLGATE_VNC_LOG=vnc_core=debug "$PROBE" "127.0.0.1:$port" "$pw" > "$log" 2>&1 ) &
  probe=$!

  # 우리가 보낸 것이 서버에 들어갔는지.
  #
  # **한 번만 읽으면 안 된다.** 값이 자리를 잡는 시점이 구현마다 다르다 — TigerVNC 는 우리가
  # notify 로 알린 뒤 서버가 request 를 보내고 provide 를 받아야 하고(xclip 이 선택 영역을
  # 요청하는 것이 그 왕복의 방아쇠다), x11vnc 는 소유권이 잠깐 비어 있는 구간이 있다. 고정
  # 시간에 한 번 읽었더니 같은 조합이 통과와 실패를 번갈아 냈다. 그래서 값이 잡힐 때까지 센다.
  pasted=""
  if [ "$expect" != "none" ]; then
    for _ in $(seq 1 20); do
      sleep 1
      pasted=$(docker exec "$name" bash -c \
        "DISPLAY=:$disp xclip -selection clipboard -o 2>/dev/null" 2>/dev/null || true)
      [ -n "$pasted" ] && break
    done
    # 반대 방향: 서버에서 복사한 값이 우리에게 들어오는지. 세션이 살아 있는 동안 바꿔야 한다.
    docker exec "$name" bash -c \
      "printf '%s' '$REMOTE_TEXT' | DISPLAY=:$disp xclip -selection clipboard -i" >/dev/null 2>&1 || true
    sleep 4
  fi
  wait "$probe" 2>/dev/null

  rects=$(grep -oE "사각형 [0-9]+개" "$log" | tail -1 | tr -dc '0-9')
  filled=$(grep -oE "\([0-9]+%\)" "$log" | tail -1 | tr -dc '0-9')
  closed=$(grep -c '^closed' "$log")
  recv=$(grep -cE "서버 클립보드\((확장|고전)\)" "$log")
  srv_err=$(docker logs "$name" 2>&1 | grep -cE "unknown message type|inflation error|corrupted|protocol error")

  note=""
  screen_ok=no; [ "${rects:-0}" -gt 0 ] && [ "${filled:-0}" -ge 100 ] && screen_ok=yes
  alive=no; [ "$closed" -eq 0 ] && [ "$srv_err" -eq 0 ] && alive=yes
  [ "$srv_err" -gt 0 ] && note="서버가 프로토콜 오류를 냈다"

  case "$expect" in
    utf8)
      paste_ok=$([ "$pasted" = "$SENT_TEXT" ] && echo yes || echo no)
      recv_ok=$([ "$recv" -gt 0 ] && echo yes || echo no)
      [ "$paste_ok" = "no" ] && note="${note:+$note; }붙여넣기값=\"$pasted\""
      [ "$recv_ok" = "no" ] && note="${note:+$note; }원격 복사가 안 들어왔다"
      ;;
    report)
      # 게이트가 아니다. 값이 무엇이었는지만 남긴다 — 고전 경로면 한글이 `?` 로 바뀌어 있다.
      if [ "$pasted" = "$SENT_TEXT" ]; then paste_ok="(utf8)"
      elif [ "$pasted" = "$SENT_TEXT_LATIN1" ]; then paste_ok="(latin1)"
      elif [ -z "$pasted" ]; then paste_ok="(없음)"
      else paste_ok="(다름)"; note="${note:+$note; }붙여넣기값=\"$pasted\""
      fi
      recv_ok=$([ "$recv" -gt 0 ] && echo "(yes)" || echo "(no)")
      ;;
    none)
      paste_ok=skip
      recv_ok=skip
      ;;
  esac

  printf '%-34s %-6s %-6s %-9s %-9s %s\n' "$desc" "$screen_ok" "$alive" "$paste_ok" "$recv_ok" "$note"
  for verdict in "$screen_ok" "$alive" "$paste_ok" "$recv_ok"; do
    [ "$verdict" = "no" ] && failures=$((failures + 1))
  done
  docker rm -f "$name" >/dev/null 2>&1
done

echo
if [ "$failures" -gt 0 ]; then
  echo "실패 $failures 건. 자세한 로그: /tmp/vnc-matrix-<mode>.log"
  exit 1
fi
echo "전부 통과"
