import { describe, expect, it } from "vitest";
import type { HostContainerDetails } from "@shared";
import { resolveContainerTunnelTarget } from "./container-port-forward-target";

function createDetails(): HostContainerDetails {
  return {
    id: "container-1",
    name: "mysql",
    runtime: "docker",
    image: "mysql:latest",
    status: "running",
    createdAt: "2025-01-01T00:00:00.000Z",
    command: "mysqld",
    entrypoint: "docker-entrypoint.sh",
    ports: [
      {
        containerPort: 3306,
        protocol: "tcp",
        publishedBindings: [
          {
            hostIp: "0.0.0.0",
            hostPort: 3309,
          },
          {
            hostIp: "::",
            hostPort: 3309,
          },
        ],
      },
      {
        containerPort: 6379,
        protocol: "tcp",
        publishedBindings: [],
      },
    ],
    mounts: [],
    networks: [
      {
        name: "bridge",
        ipAddress: "172.17.0.5",
        aliases: [],
      },
    ],
    environment: [],
    labels: [],
  };
}

describe("container tunnel target resolution", () => {
  it("always uses the selected container network IP and internal port", () => {
    const details = createDetails();
    expect(resolveContainerTunnelTarget(details, "bridge", 3306)).toEqual({
      host: "172.17.0.5",
      port: 3306,
      source: "container-network",
    });
  });

  it("uses the selected network IP when no published binding exists", () => {
    const details = createDetails();
    expect(resolveContainerTunnelTarget(details, "bridge", 6379)).toEqual({
      host: "172.17.0.5",
      port: 6379,
      source: "container-network",
    });
  });
});

describe("네트워크를 고르지 않았을 때", () => {
  it("IP 가 있는 첫 네트워크를 우리가 고른다", () => {
    const details = createDetails();
    const target = resolveContainerTunnelTarget(details, "", 3306);
    expect(target.host).toBe(
      details.networks.find((network) => network.ipAddress)?.ipAddress,
    );
    expect(target.port).toBe(3306);
  });

  it("IP 없는 네트워크는 건너뛴다", () => {
    const details = {
      ...createDetails(),
      networks: [
        { name: "none", ipAddress: "", aliases: [] },
        { name: "bridge", ipAddress: "172.18.0.5", aliases: [] },
      ],
    };
    expect(resolveContainerTunnelTarget(details, "", 3306).host).toBe("172.18.0.5");
  });

  it("붙은 네트워크가 없으면 무엇을 봤는지 적어 알린다", () => {
    const details = { ...createDetails(), networks: [] };
    expect(() => resolveContainerTunnelTarget(details, "", 3306)).toThrow();
  });

  it("공개되지 않은 포트도 대상이 된다 — 컨테이너 네트워크로 바로 간다", () => {
    // 코어의 inspect 는 Config.Exposed 까지 포함하므로 공개 안 된 포트도 목록에 있다.
    const details = {
      ...createDetails(),
      ports: [{ containerPort: 9090, protocol: "tcp", publishedBindings: [] }],
    };
    expect(resolveContainerTunnelTarget(details, "", 9090).port).toBe(9090);
  });
});

describe("host 네트워킹", () => {
  function createHostNetworked(): HostContainerDetails {
    return {
      ...createDetails(),
      name: "node-exporter",
      // host 모드 컨테이너는 자기 IP 가 없다 — inspect 가 이름만 주고 IP 는 빈 문자열이다.
      networks: [{ name: "host", ipAddress: "", aliases: [] }],
      ports: [{ containerPort: 9100, protocol: "tcp", publishedBindings: [] }],
    };
  }

  it("IP 가 없으면 그 호스트의 루프백으로 간다", () => {
    expect(resolveContainerTunnelTarget(createHostNetworked(), "", 9100)).toEqual({
      host: "127.0.0.1",
      port: 9100,
      source: "host-network",
    });
  });

  it("네트워크를 host 로 지정해도 같다", () => {
    expect(resolveContainerTunnelTarget(createHostNetworked(), "host", 9100)).toEqual({
      host: "127.0.0.1",
      port: 9100,
      source: "host-network",
    });
  });

  it("IP 가 있는 네트워크가 있으면 그쪽이 이긴다", () => {
    const details = {
      ...createHostNetworked(),
      networks: [
        { name: "host", ipAddress: "", aliases: [] },
        { name: "bridge", ipAddress: "172.19.0.4", aliases: [] },
      ],
    };
    expect(resolveContainerTunnelTarget(details, "", 9100).host).toBe("172.19.0.4");
  });

  it("host 가 아니면서 IP 도 없으면 여전히 알린다 — --network none 같은 경우", () => {
    const details = {
      ...createHostNetworked(),
      networks: [{ name: "none", ipAddress: "", aliases: [] }],
    };
    expect(() => resolveContainerTunnelTarget(details, "", 9100)).toThrow();
  });

  it("host 네트워킹이어도 모르는 포트는 대상이 되지 않는다", () => {
    expect(() => resolveContainerTunnelTarget(createHostNetworked(), "", 9200)).toThrow();
  });
});
