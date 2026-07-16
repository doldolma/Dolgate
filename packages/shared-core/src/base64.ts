// 의존성 없는 base64 인코딩/디코딩.
//
// shared-core 는 데스크톱 메인(Node)·데스크톱 렌더러(vite dev)·모바일(Hermes) 세 런타임에서
// 그대로 로드된다. base64-js 같은 CommonJS 패키지는 vite dev 서버가 링크된 워크스페이스
// 소스 경유로 서빙할 때 named export 인터롭이 안 돼 렌더러가 통째로 죽고(빈 화면),
// atob/btoa·Buffer 는 런타임마다 존재 여부가 달라서 — 순수 구현으로 둔다.
// 결과 정확성은 vault-test-vectors.json 의 base64 값 일치로 함께 검증된다.

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_LOOKUP = (() => {
  const lookup = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    lookup[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return lookup;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index];
    const hasByte1 = index + 1 < bytes.length;
    const hasByte2 = index + 2 < bytes.length;
    const byte1 = hasByte1 ? bytes[index + 1] : 0;
    const byte2 = hasByte2 ? bytes[index + 2] : 0;

    output += BASE64_ALPHABET[byte0 >> 2];
    output += BASE64_ALPHABET[((byte0 & 0x03) << 4) | (byte1 >> 4)];
    output += hasByte1
      ? BASE64_ALPHABET[((byte1 & 0x0f) << 2) | (byte2 >> 6)]
      : "=";
    output += hasByte2 ? BASE64_ALPHABET[byte2 & 0x3f] : "=";
  }
  return output;
}

export function base64ToBytes(value: string): Uint8Array {
  const trimmed = value.replace(/[\s]/g, "");
  const unpadded = trimmed.replace(/=+$/, "");
  const remainder = unpadded.length % 4;
  if (remainder === 1) {
    throw new Error("잘못된 base64 입력입니다.");
  }

  const byteLength = Math.floor((unpadded.length * 3) / 4);
  const bytes = new Uint8Array(byteLength);
  let byteIndex = 0;
  let buffer = 0;
  let bitsCollected = 0;

  for (let index = 0; index < unpadded.length; index += 1) {
    const code = unpadded.charCodeAt(index);
    const sextet = code < 128 ? BASE64_LOOKUP[code] : -1;
    if (sextet < 0) {
      throw new Error("잘못된 base64 입력입니다.");
    }
    buffer = (buffer << 6) | sextet;
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes[byteIndex] = (buffer >> bitsCollected) & 0xff;
      byteIndex += 1;
    }
  }
  return bytes;
}
