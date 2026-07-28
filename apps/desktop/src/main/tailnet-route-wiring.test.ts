import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * tailnet 경로가 빠진 연결 경로는 조용히 일반 네트워크로 나간다 — 실패가 아니라 "왜 tailnet 을
 * 지정했는데 안 되지"로 보인다. 각 경로의 통합 테스트로는 실제 SSH 서버가 필요하므로,
 * 페이로드를 만드는 자리마다 경로를 넣었는지 소스로 확인한다.
 *
 * tmux 와 mosh 는 셸과 같은 connect 페이로드를 쓰므로 ssh.ts 하나로 세 경로가 덮인다.
 */
describe('tailnet route wiring', () => {
  const sites = [
    { name: 'shell / tmux / mosh', file: 'ipc/ssh.ts' },
    { name: 'sftp', file: 'ipc/sftp.ts' },
    { name: 'port forwarding', file: 'ipc/port-forwards-dns.ts' },
    { name: 'containers', file: 'ipc/coordinators/container-runtime-coordinator.ts' },
    { name: 'host key probe', file: 'ipc/coordinators/host-coordinator.ts' },
  ];

  for (const site of sites) {
    it(`passes the tailnet route when connecting for ${site.name}`, () => {
      const source = readFileSync(join(__dirname, site.file), 'utf8');

      expect(
        source.includes('resolveTailnetRoute('),
        `${site.file} never spreads the tailnet route, so a tailnet host would connect over the plain network`,
      ).toBe(true);
    });
  }
});
