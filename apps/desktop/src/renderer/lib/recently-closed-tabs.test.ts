import { beforeEach, describe, expect, it } from "vitest";
import {
  clearClosedHosts,
  popClosedHost,
  pushClosedHost,
} from "./recently-closed-tabs";

describe("recently-closed-tabs", () => {
  beforeEach(() => clearClosedHosts());

  it("pops most-recently-closed first (LIFO)", () => {
    pushClosedHost("a");
    pushClosedHost("b");
    expect(popClosedHost()).toBe("b");
    expect(popClosedHost()).toBe("a");
    expect(popClosedHost()).toBeNull();
  });

  it("keeps duplicates so each close is reopenable", () => {
    pushClosedHost("a");
    pushClosedHost("a");
    expect(popClosedHost()).toBe("a");
    expect(popClosedHost()).toBe("a");
    expect(popClosedHost()).toBeNull();
  });

  it("remembers a deep history (>=10) in reverse order", () => {
    const hosts = Array.from({ length: 12 }, (_unused, i) => `h${i}`);
    hosts.forEach(pushClosedHost);
    for (let i = hosts.length - 1; i >= 0; i -= 1) {
      expect(popClosedHost()).toBe(hosts[i]);
    }
    expect(popClosedHost()).toBeNull();
  });

  it("ignores empty hostId", () => {
    pushClosedHost("");
    expect(popClosedHost()).toBeNull();
  });
});
