import {
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isSerialHostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  type HostRecord,
  type TerminalTab,
} from "@shared";
import { redactAiContext } from "./ai-context-redact";
import { t } from '../i18n';

export const AI_RECENT_OUTPUT_LINES = 100;

type SessionContextTab =
  | Pick<TerminalTab, "title" | "source" | "status" | "hostId">
  | null
  | undefined;

function appendLine(lines: string[], label: string, value: unknown): void {
  if (value === null || value === undefined || value === "") {
    return;
  }
  lines.push(`- ${label}: ${String(value)}`);
}

function yesNo(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value ? "yes" : "no";
}

function jumpHostSummary(host: Extract<HostRecord, { kind: "ssh" }>): string {
  const count = host.jumpHostIds?.length ?? (host.jumpHostId ? 1 : 0);
  return count > 0 ? `${count} configured` : "none";
}

export function buildHostContext(tab: SessionContextTab, host: HostRecord | null | undefined): string {
  const lines: string[] = [];

  if (tab) {
    lines.push("Session:");
    appendLine(lines, "title", tab.title);
    appendLine(lines, "source", tab.source);
    appendLine(lines, "status", tab.status);
  }

  if (!host) {
    if (tab?.hostId) {
      appendLine(lines, "hostRecord", "not found");
    }
    return lines.join("\n");
  }

  if (lines.length > 0) {
    lines.push("");
  }
  lines.push("Host:");
  appendLine(lines, "label", host.label);
  appendLine(lines, "kind", host.kind);
  appendLine(lines, "group", host.groupName);
  if (host.tags?.length) {
    appendLine(lines, "tags", host.tags.join(", "));
  }

  if (isSshHostRecord(host)) {
    appendLine(lines, "address", `${host.username}@${host.hostname}:${host.port}`);
    appendLine(lines, "authType", host.authType);
    appendLine(lines, "jumpHosts", jumpHostSummary(host));
    appendLine(lines, "mosh", yesNo(host.useMosh));
    appendLine(lines, "agentForwarding", yesNo(host.agentForwarding));
    return lines.join("\n");
  }

  if (isAwsEc2HostRecord(host)) {
    appendLine(lines, "awsProfile", host.awsProfileName);
    appendLine(lines, "region", host.awsRegion);
    appendLine(lines, "availabilityZone", host.awsAvailabilityZone);
    appendLine(lines, "instanceId", host.awsInstanceId);
    appendLine(lines, "instanceName", host.awsInstanceName);
    appendLine(lines, "platform", host.awsPlatform);
    appendLine(lines, "privateIp", host.awsPrivateIp);
    appendLine(lines, "state", host.awsState);
    appendLine(lines, "sshUsername", host.awsSshUsername);
    appendLine(lines, "sshPort", host.awsSshPort);
    appendLine(lines, "ssmServerProxy", yesNo(host.awsSsmServerProxyEnabled));
    appendLine(lines, "agentForwarding", yesNo(host.agentForwarding));
    return lines.join("\n");
  }

  if (isAwsEcsHostRecord(host)) {
    appendLine(lines, "awsProfile", host.awsProfileName);
    appendLine(lines, "region", host.awsRegion);
    appendLine(lines, "clusterName", host.awsEcsClusterName);
    return lines.join("\n");
  }

  if (isWarpgateSshHostRecord(host)) {
    appendLine(lines, "warpgateUrl", host.warpgateBaseUrl);
    appendLine(lines, "targetName", host.warpgateTargetName);
    appendLine(lines, "sshHost", host.warpgateSshHost);
    appendLine(lines, "sshPort", host.warpgateSshPort);
    appendLine(lines, "username", host.warpgateUsername);
    return lines.join("\n");
  }

  if (isSerialHostRecord(host)) {
    appendLine(lines, "transport", host.transport);
    appendLine(lines, "devicePath", host.devicePath);
    appendLine(lines, "networkTarget", host.host && host.port ? `${host.host}:${host.port}` : null);
    appendLine(lines, "baudRate", host.baudRate);
    appendLine(lines, "dataBits", host.dataBits);
    appendLine(lines, "parity", host.parity);
    appendLine(lines, "stopBits", host.stopBits);
    appendLine(lines, "flowControl", host.flowControl);
    appendLine(lines, "lineEnding", host.transmitLineEnding);
    appendLine(lines, "localEcho", yesNo(host.localEcho));
    return lines.join("\n");
  }

  return lines.join("\n");
}

export function buildAiSessionContext({
  tab,
  host,
  recentTerminalText,
  recentOutputLines = AI_RECENT_OUTPUT_LINES,
}: {
  tab: SessionContextTab;
  host: HostRecord | null | undefined;
  recentTerminalText: string;
  recentOutputLines?: number;
}): string | undefined {
  const sections: string[] = [];
  const hostContext = buildHostContext(tab, host).trim();
  if (hostContext) {
    sections.push(`${t('aiContext.hostInfo')}\n${hostContext}`);
  }

  const terminalText = redactAiContext(recentTerminalText).trim();
  if (terminalText) {
    sections.push(
      `${t('aiContext.recentOutput', { lines: recentOutputLines })}\n\`\`\`\n${terminalText}\n\`\`\``,
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
