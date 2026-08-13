#!/bin/bash
# 검증용 VNC 서버 이미지를 만든다. matrix.sh 가 이 이미지를 쓴다.
set -eu
cd "$(dirname "$0")"
docker build -t dolgate-vnc-testing:latest .
