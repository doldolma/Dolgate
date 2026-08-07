/**
 * IP 주소가 CIDR 대역 안에 드는지 판정한다.
 *
 * tailnet 을 거쳐 가는 호스트가 전부 tailnet 노드인 것은 아니다 — tailscale 이 깔려 있지 않은
 * 사내망 장비는 서브넷 라우터가 광고하는 대역을 통해 닿는다. 그런 호스트의 경로를 말하려면
 * "이 IP 를 담당하는 라우터가 누구인지"를 대역 비교로 찾아야 한다.
 *
 * 라이브러리를 들이지 않는다 — 필요한 것은 접두 비트 비교뿐이고, 이 코드는 렌더러에서 돈다.
 */

/** IPv4 를 32비트 정수로. 점 넷·0~255 가 아니면 null(주소가 아니다). */
function parseIPv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    // 앞자리 0 을 허용하면 "010" 이 8진수로 읽히는 구현과 어긋난다. 숫자만, 3자리까지.
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value;
}

/** IPv6 를 16바이트로. `::` 축약과 끝의 IPv4 표기(`::ffff:1.2.3.4`)를 받는다. */
function parseIPv6(text: string): Uint8Array | null {
  let body = text;
  // 존 인덱스(%eth0)는 주소 자체가 아니다.
  const zone = body.indexOf('%');
  if (zone >= 0) {
    body = body.slice(0, zone);
  }
  if (!body.includes(':')) {
    return null;
  }

  // 끝이 IPv4 표기면 마지막 두 그룹으로 바꿔 놓고 나머지를 일반 경로로 처리한다.
  const lastColon = body.lastIndexOf(':');
  const tail = body.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) {
      return null;
    }
    const high = ((v4 >>> 16) & 0xffff).toString(16);
    const low = (v4 & 0xffff).toString(16);
    body = `${body.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = body.split('::');
  if (halves.length > 2) {
    return null;
  }
  const toGroups = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }
    const groups: number[] = [];
    for (const chunk of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) {
        return null;
      }
      groups.push(parseInt(chunk, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) {
    return null;
  }
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }
  const groups = [...head, ...new Array<number>(Math.max(0, missing)).fill(0), ...rest];
  if (groups.length !== 8) {
    return null;
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** 두 바이트열의 앞 `bits` 비트가 같은지. */
function samePrefix(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  const remainder = bits % 8;
  if (remainder === 0) {
    return true;
  }
  const mask = 0xff << (8 - remainder);
  return (a[whole] & mask) === (b[whole] & mask);
}

function toBytes(address: string): Uint8Array | null {
  const v4 = parseIPv4(address);
  if (v4 !== null) {
    return Uint8Array.of((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
  }
  return parseIPv6(address);
}

/** 주소가 IP 로 읽히는지. 호스트 이름과 IP 를 가르는 데 쓴다. */
export function isIpAddress(address: string): boolean {
  return toBytes(address.trim()) !== null;
}

/**
 * `address` 가 `cidr` 안에 드는지. 읽을 수 없는 값이면 false 다 — 판정할 수 없는 것을
 * "속한다"로 읽으면 엉뚱한 라우터를 경로로 보고하게 된다.
 *
 * 주소 계열이 다르면(IPv4 주소 대 IPv6 대역) 속하지 않는다.
 */
export function isAddressInCidr(address: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/');
  if (slash < 0) {
    return false;
  }
  const bitsText = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsText)) {
    return false;
  }
  const bits = Number(bitsText);
  const network = toBytes(cidr.slice(0, slash).trim());
  const target = toBytes(address.trim());
  if (!network || !target || network.length !== target.length) {
    return false;
  }
  if (bits > network.length * 8) {
    return false;
  }
  return samePrefix(network, target, bits);
}

/** CIDR 의 접두 길이. 더 구체적인 대역을 고르는 데 쓴다(못 읽으면 -1). */
export function cidrPrefixLength(cidr: string): number {
  const slash = cidr.lastIndexOf('/');
  if (slash < 0) {
    return -1;
  }
  const bitsText = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsText)) {
    return -1;
  }
  const network = toBytes(cidr.slice(0, slash).trim());
  if (!network) {
    return -1;
  }
  const bits = Number(bitsText);
  return bits > network.length * 8 ? -1 : bits;
}
