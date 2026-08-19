import { useEffect, useRef, useState } from "react";
import type { RdpSessionEvent } from "@shared";
import { sendRdpMicrophoneAudio, subscribeRdpEvents } from "../../services/desktop/rdp";

/**
 * 한 번에 보낼 최소 프레임 수.
 *
 * 서버가 OPEN 에서 원하는 크기(frames_per_packet)를 알려 주지만 아주 작을 수 있다(441 = 10ms).
 * 그 크기로 그대로 보내면 초당 100번 IPC 를 타고, 그 왕복이 캡처보다 비싸진다. 40ms 어치로 모아
 * 보낸다 — 사람이 통화에서 알아채는 지연(150ms 이상)보다 한참 아래다.
 */
const MIN_CHUNK_SECONDS = 0.04;

/** 협상된 캡처 사양. `microphoneFormat` 이벤트로 온다. */
interface CaptureFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * 마이크 권한·장치 상태. 화면이 사용자에게 보여줄 것이 있는 경우만 값이 있다.
 *
 * 마이크는 조용히 실패하면 사용자가 원격에서 말하고 있는데 아무도 못 듣는 상황이 된다 — 그건
 * 반드시 보여야 한다.
 */
export type MicrophoneProblem =
  | "denied"
  | "noDevice"
  | "failed"
  /** 우리는 요청했지만 서버가 마이크 리디렉션을 열지 않았다(서버 정책). */
  | "serverRefused";

/**
 * 로컬 마이크를 잡아 원격으로 보낸다(AUDIO_INPUT).
 *
 * **서버가 사양을 정한다.** 코어가 audin 협상을 마치면 `microphoneFormat` 이벤트로 sample rate 와
 * 채널 수가 오고, 그 사양대로 캡처해야 원격에서 소리가 빠르거나 느리게 들리지 않는다. 그래서 이
 * 훅은 그 이벤트를 받은 뒤에 마이크를 연다 — 미리 열면 사용자에게 권한을 묻고도 쓰지 못한 채
 * 다시 열어야 할 수 있다.
 *
 * 변환은 여기서 한다: Web Audio 는 Float32 를 주고 RDP 는 16-bit 정수를 받는다. 채널 수가 1 이면
 * 다운믹스도 여기서 한다(원격이 모노를 고르는 경우가 흔하다).
 */
export function useRdpMicrophone(
  sessionId: string,
  enabled: boolean,
): { active: boolean; problem: MicrophoneProblem | null } {
  const [format, setFormat] = useState<CaptureFormat | null>(null);
  const [active, setActive] = useState(false);
  const [problem, setProblem] = useState<MicrophoneProblem | null>(null);
  // 정리 순서를 지키기 위해 살아 있는 자원을 모아 둔다.
  const teardownRef = useRef<(() => void) | null>(null);

  // 1) 협상된 사양을 기다린다.
  useEffect(() => {
    if (!enabled) {
      setFormat(null);
      return;
    }
    return subscribeRdpEvents((event: RdpSessionEvent) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.type === "microphoneUnavailable") {
        // 서버가 채널을 열지 않았다. 마이크를 열 이유가 없으므로 권한도 묻지 않고 이유만 알린다.
        setProblem("serverRefused");
        return;
      }
      if (event.type !== "microphoneFormat") {
        return;
      }
      const payload = event.payload as {
        sampleRate?: number;
        channels?: number;
        bitsPerSample?: number;
      };
      if (
        typeof payload.sampleRate !== "number" ||
        typeof payload.channels !== "number" ||
        payload.bitsPerSample !== 16
      ) {
        // 우리는 16-bit PCM 만 광고한다. 다른 값이 오면 해석이 달라져 잡음이 되므로 열지 않는다.
        return;
      }
      setFormat({
        sampleRate: payload.sampleRate,
        channels: payload.channels,
        bitsPerSample: payload.bitsPerSample,
      });
    });
  }, [enabled, sessionId]);

  // 2) 사양이 정해지면 마이크를 열어 흘려보낸다.
  useEffect(() => {
    if (!enabled || !format) {
      return;
    }
    let cancelled = false;

    const start = async () => {
      let stream: MediaStream;
      try {
        // 원격이 고른 사양을 그대로 요청한다. 브라우저가 못 맞추면 자기 사양으로 주고,
        // AudioContext 가 그 차이를 리샘플링한다.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: format.sampleRate,
            channelCount: format.channels,
            // 원격 회의·통화가 주 용도다. 브라우저의 기본 처리를 그대로 쓴다 — 끄면 에코가 그대로
            // 원격으로 넘어간다.
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        // 사용자가 거부한 것과 장치가 없는 것은 다른 안내가 필요하다.
        const name = error instanceof DOMException ? error.name : "";
        setProblem(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : name === "NotFoundError"
              ? "noDevice"
              : "failed",
        );
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      let context: AudioContext;
      try {
        context = new AudioContext({ sampleRate: format.sampleRate });
      } catch {
        // 장치가 그 사양을 못 열면 기본값으로 열고, 아래 리샘플링이 차이를 메운다.
        context = new AudioContext();
      }
      const source = context.createMediaStreamSource(stream);
      // ScriptProcessor 는 낡았지만 AudioWorklet 은 별도 모듈 파일을 로드해야 한다 — 이 앱은
      // 번들 하나로 돌고, 캡처 한 줄기에 워크릿 로더를 들이는 것은 과하다. 버퍼 크기는 2의
      // 거듭제곱만 받는다.
      const processor = context.createScriptProcessor(4096, format.channels, 1);
      const targetRate = format.sampleRate;
      const channelCount = format.channels;
      const minSamples = Math.max(1, Math.floor(targetRate * MIN_CHUNK_SECONDS)) * channelCount;
      // 인터리브된 샘플(프레임 하나가 채널 수만큼 연속으로 들어간다).
      let pending: number[] = [];

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const frames = input.length;
        const available = input.numberOfChannels;
        // 채널 배열은 콜백마다 한 번만 꺼낸다.
        const sources: Float32Array[] = [];
        for (let channel = 0; channel < available; channel += 1) {
          sources.push(input.getChannelData(channel));
        }

        // **원격이 정한 채널 수대로 인터리브해서 보낸다.** 예전에는 무조건 모노로 다운믹스했는데,
        // 서버가 스테레오로 열면(실측: 44100Hz 2ch) 프레임당 바이트 수가 절반이라 원격에서는
        // 소리로 성립하지 않는다.
        const frameAt = (index: number): void => {
          if (channelCount === 1 && available > 1) {
            // 원격이 모노를 골랐다. 한쪽만 쓰면 그 채널이 조용한 기기에서 소리가 사라진다.
            let sum = 0;
            for (const source of sources) {
              sum += source[index] ?? 0;
            }
            pending.push(sum / available);
            return;
          }
          for (let channel = 0; channel < channelCount; channel += 1) {
            // 원격이 요구하는 채널이 마이크보다 많으면 있는 채널을 복제한다(모노 마이크 → 스테레오).
            const source = sources[Math.min(channel, available - 1)];
            pending.push(source?.[index] ?? 0);
          }
        };

        // 컨텍스트가 원격 사양으로 열리지 못했으면 비율만큼 뽑아 쓴다. 최근접 이웃이라 품질이
        // 최고는 아니지만, 음성에서는 알아듣는 데 지장이 없고 지연을 늘리지 않는다.
        const ratio = targetRate / input.sampleRate;
        if (Math.abs(ratio - 1) < 0.001) {
          for (let index = 0; index < frames; index += 1) {
            frameAt(index);
          }
        } else {
          const outFrames = Math.floor(frames * ratio);
          for (let index = 0; index < outFrames; index += 1) {
            frameAt(Math.floor(index / ratio));
          }
        }

        if (pending.length < minSamples) {
          return;
        }
        const samples = pending;
        pending = [];
        const pcm = new Int16Array(samples.length);
        for (let index = 0; index < samples.length; index += 1) {
          // 넘치는 값을 그대로 잘라 쓰면 소리가 찢어진다. 범위로 먼저 묶는다.
          const clamped = Math.max(-1, Math.min(1, samples[index]));
          pcm[index] = Math.round(clamped * 0x7fff);
        }
        sendRdpMicrophoneAudio(sessionId, pcm.buffer);
      };

      source.connect(processor);
      // ScriptProcessor 는 목적지에 연결돼야 콜백이 돈다. 무음 게인을 거쳐 붙여, 캡처한 소리가
      // 로컬 스피커로 새지 않게 한다(그러면 사용자가 자기 목소리를 듣는다).
      const silence = context.createGain();
      silence.gain.value = 0;
      processor.connect(silence);
      silence.connect(context.destination);
      await context.resume().catch(() => undefined);

      setActive(true);
      setProblem(null);
      teardownRef.current = () => {
        processor.onaudioprocess = null;
        processor.disconnect();
        silence.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void context.close().catch(() => undefined);
      };
    };

    void start();

    return () => {
      cancelled = true;
      teardownRef.current?.();
      teardownRef.current = null;
      setActive(false);
    };
  }, [enabled, format, sessionId]);

  return { active, problem };
}
