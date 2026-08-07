import { describe, expect, it } from 'vitest';
import { cidrPrefixLength, isAddressInCidr, isIpAddress } from './ip-prefix';

describe('isIpAddress', () => {
  it('reads IPv4 and IPv6', () => {
    expect(isIpAddress('192.168.0.13')).toBe(true);
    expect(isIpAddress('100.64.0.9')).toBe(true);
    expect(isIpAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isIpAddress('::1')).toBe(true);
  });

  // 호스트 이름을 IP 로 읽으면 엉뚱한 라우터를 경로로 보고하게 된다.
  it('rejects host names and malformed addresses', () => {
    expect(isIpAddress('agt-1')).toBe(false);
    expect(isIpAddress('agt-1.example.ts.net')).toBe(false);
    expect(isIpAddress('192.168.0')).toBe(false);
    expect(isIpAddress('192.168.0.256')).toBe(false);
    expect(isIpAddress('')).toBe(false);
  });
});

describe('isAddressInCidr', () => {
  it('matches inside an IPv4 subnet', () => {
    expect(isAddressInCidr('192.168.0.13', '192.168.0.0/24')).toBe(true);
    expect(isAddressInCidr('192.168.0.255', '192.168.0.0/24')).toBe(true);
  });

  it('rejects outside an IPv4 subnet', () => {
    expect(isAddressInCidr('192.168.1.13', '192.168.0.0/24')).toBe(false);
    expect(isAddressInCidr('10.0.0.1', '192.168.0.0/16')).toBe(false);
  });

  // 바이트 경계가 아닌 접두 길이에서 마스크를 틀리기 쉽다.
  it('handles prefixes that do not fall on a byte boundary', () => {
    expect(isAddressInCidr('10.0.5.7', '10.0.4.0/22')).toBe(true);
    expect(isAddressInCidr('10.0.8.7', '10.0.4.0/22')).toBe(false);
    expect(isAddressInCidr('192.168.0.130', '192.168.0.128/25')).toBe(true);
    expect(isAddressInCidr('192.168.0.127', '192.168.0.128/25')).toBe(false);
  });

  it('handles IPv6', () => {
    expect(isAddressInCidr('fd7a:115c:a1e0::5', 'fd7a:115c:a1e0::/48')).toBe(true);
    expect(isAddressInCidr('fd7a:115c:a1e1::5', 'fd7a:115c:a1e0::/48')).toBe(false);
  });

  // 계열이 다르면 비교 자체가 성립하지 않는다.
  it('does not mix address families', () => {
    expect(isAddressInCidr('192.168.0.13', 'fd7a::/16')).toBe(false);
    expect(isAddressInCidr('fd7a::1', '192.168.0.0/24')).toBe(false);
  });

  it('rejects values it cannot read', () => {
    expect(isAddressInCidr('192.168.0.13', '192.168.0.0')).toBe(false);
    expect(isAddressInCidr('192.168.0.13', '192.168.0.0/xx')).toBe(false);
    expect(isAddressInCidr('192.168.0.13', '192.168.0.0/33')).toBe(false);
    expect(isAddressInCidr('agt-1', '192.168.0.0/24')).toBe(false);
  });

  // /0 은 모든 주소를 포함한다. 코어가 걸러 보내지만 여기서도 뜻은 지켜야 한다.
  it('treats a default route as containing everything', () => {
    expect(isAddressInCidr('192.168.0.13', '0.0.0.0/0')).toBe(true);
  });
});

describe('cidrPrefixLength', () => {
  it('reports the prefix length', () => {
    expect(cidrPrefixLength('192.168.0.0/24')).toBe(24);
    expect(cidrPrefixLength('fd7a::/48')).toBe(48);
  });

  it('reports -1 for values it cannot read', () => {
    expect(cidrPrefixLength('192.168.0.0')).toBe(-1);
    expect(cidrPrefixLength('192.168.0.0/33')).toBe(-1);
  });
});
