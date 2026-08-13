# 실서버 검증용 VNC 서버 모음. MODE 로 갈라 하나를 띄운다(start.sh).
#
# **우분투 24.04 로 맞춘다.** 데비안 12 의 TigerVNC 는 규격을 어긴 클립보드 메시지를 관대하게
# 받아넘겨서, 그 위에서만 검증했을 때 결함 두 개를 놓쳤다(caps 의 동작 비트 누락, zlib 스트림
# 완결). 엄격한 쪽을 기준으로 둬야 실제 사용자 환경에서 나는 문제가 여기서 난다.
#
# 한 이미지에 여러 구현체를 담는 이유는 이 확장들이 구현체마다 다르게 반쪽이기 때문이다 —
# 하나만으로는 "우리가 규격을 지켰는지" 를 알 수 없다.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server tigervnc-tools \
      tightvncserver \
      x11vnc xvfb \
      qemu-system-x86 \
      xterm x11-utils xclip xfonts-base \
      openssl ca-certificates procps iproute2 \
    && rm -rf /var/lib/apt/lists/*

COPY start.sh /start.sh
RUN chmod +x /start.sh
ENTRYPOINT ["/start.sh"]
