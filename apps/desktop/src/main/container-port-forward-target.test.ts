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
