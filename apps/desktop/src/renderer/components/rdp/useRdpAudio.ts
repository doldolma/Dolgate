import { useEffect, useRef } from "react";
import type { RdpAudioPayload } from "@shared";
import { subscribeRdpAudio } from "../../services/desktop/rdp";

/**
 * 재생 지연 목표(초).
 *
 * 원격 오디오는 일정한 간격으로 오지 않는다. 여유 없이 바로 재생하면 조각 사이가 벌어질 때마다
 * 끊기고, 너무 크게 잡으면 화면과 소리가 어긋난다. 80ms 는 그 사이의 흔한 절충이다.
 */
const TARGET_LATENCY_S = 0.08;

/**
 * 재생 시각이 이만큼 밀리면 따라잡기를 포기하고 현재 시각으로 리셋한다.
 *
 * 탭이 백그라운드였거나 네트워크가 끊겼다 돌아오면 밀린 조각이 한꺼번에 쌓이는데, 그것을 전부
 * 재생하면 몇 초 지난 소리가 계속 나온다. 버리고 현재로 붙는 편이 낫다.
 */
const RESYNC_THRESHOLD_S = 0.5;

/**
 * 원격 오디오를 재생한다.
 *
 * rdp-core 가 PCM 만 광고하므로 여기서 디코딩할 것은 없다 — 16비트 정수를 float 로 바꿔
 * AudioBuffer 에 넣고 순서대로 이어 붙이면 된다.
 */
export function useRdpAudio(sessionId: string, enabled: boolean): void {
  const contextRef = useRef<AudioContext | null>(null);
  // 다음 조각을 재생할 시각. AudioContext 시계 기준이다.
  const nextStartRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const play = (frame: RdpAudioPayload) => {
      if (frame.bitsPerSample !== 16) {
        // 우리는 16비트만 광고한다. 다른 값이 오면 해석이 달라져 잡음이 되므로 버린다.
        return;
      }

      let context = contextRef.current;
      if (!context) {
        // 소리가 실제로 오기 전에는 만들지 않는다. AudioContext 는 자원을 잡고, 조용한
        // 세션에서까지 열어둘 이유가 없다.
        //
        // 원격이 보내는 샘플레이트를 그대로 요청하되, 출력 장치가 그 값을 받지 못하면 예외가
        // 난다. 그때는 장치 기본값으로 열고 재생 쪽에서 변환하게 둔다 — 여기서 던지면 소리가
        // 아예 나지 않는다.
        try {
          context = new AudioContext({ sampleRate: frame.sampleRate });
        } catch {
          context = new AudioContext();
        }
        contextRef.current = context;
        nextStartRef.current = 0;
      }

      // 사용자 조작 없이 만든 컨텍스트는 멈춘 채로 시작한다. 깨우지 않으면 조각을 아무리
      // 이어 붙여도 소리가 나지 않는다.
      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }

      const channels = Math.max(1, frame.channels);
      // Int16Array 는 2바이트 정렬을 요구한다. IPC 로 온 뷰의 byteOffset 이 홀수면 생성자가
      // 예외를 던지므로, 그때는 사본을 떠서 정렬을 맞춘다(드문 경로라 비용이 문제되지 않는다).
      const aligned =
        frame.pcm.byteOffset % 2 === 0
          ? frame.pcm
          : new Uint8Array(frame.pcm);
      const samples = new Int16Array(
        aligned.buffer as ArrayBuffer,
        aligned.byteOffset,
        Math.floor(aligned.byteLength / 2),
      );
      const frameCount = Math.floor(samples.length / channels);
      if (frameCount === 0) {
        return;
      }

      const buffer = context.createBuffer(channels, frameCount, frame.sampleRate);
      for (let channel = 0; channel < channels; channel += 1) {
        const target = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i += 1) {
          // 인터리브된 정수를 채널별 float(-1..1)로 편다. 32768 로 나누는 것은 Int16 의
          // 음수 쪽 최대치가 -32768 이기 때문이다.
          target[i] = samples[i * channels + channel] / 32768;
        }
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      const now = context.currentTime;
      let startAt = nextStartRef.current;
      if (startAt < now || startAt > now + RESYNC_THRESHOLD_S) {
        // 처음이거나, 이미 지나갔거나, 너무 앞서 있다. 목표 지연만큼 띄워 현재에 다시 붙인다.
        //
        // 여유가 줄었다는 이유만으로 다시 붙이면 안 된다. 조각이 조금씩 늦게 오는 것만으로도
        // 매번 새로 시작하게 되어, 소리가 나다 끊기다를 반복한다.
        startAt = now + TARGET_LATENCY_S;
      }

      source.start(startAt);
      nextStartRef.current = startAt + buffer.duration;
    };

    const unsubscribe = subscribeRdpAudio(sessionId, play);

    return () => {
      unsubscribe();
      // 세션이 끝나면 컨텍스트를 놓아준다. 남겨두면 탭마다 하나씩 쌓인다.
      void contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
      nextStartRef.current = 0;
    };
  }, [sessionId, enabled]);
}
