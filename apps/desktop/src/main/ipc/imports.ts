import {
  getGroupLabel,
  getParentGroupPath,
  normalizeGroupPath,
  type OpenSshImportSelectionInput,
  type OpenSshImportWarning,
  type OpenSshSnapshotFileInput,
  type TermiusImportSelectionInput,
  type XshellImportSelectionInput,
  type XshellImportWarning,
  type XshellSnapshotFolderInput,
} from "@shared";
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import { resolveOpenSshIdentityImport } from "../openssh-import-service";
import { importTermiusSelection } from "../termius-import-executor";
import { buildTermiusGroupAncestorPaths } from "../termius-import-service";
import {
  collectSelectedXshellGroupPaths,
  collectSelectedXshellHosts,
} from "../xshell-import-service";
import {
  decryptXshellPassword,
  resolveCurrentXshellPasswordSecurityContext,
} from "../xshell-password-decryptor";
import type { MainIpcContext } from "./context";

export function registerImportIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.termius.probeLocal, async () => {
    return ctx.termiusImportService.probeLocal();
  });

  ipcMain.handle(ipcChannels.openssh.probeDefault, async () => {
    return ctx.opensshImportService.probeDefault(ctx.buildKnownSshDuplicateKeys());
  });

  ipcMain.handle(ipcChannels.xshell.probeDefault, async () => {
    return ctx.xshellImportService.probeDefault(ctx.buildKnownSshDuplicateKeys());
  });

  ipcMain.handle(
    ipcChannels.openssh.addFileToSnapshot,
    async (_event, input: OpenSshSnapshotFileInput) => {
      return ctx.opensshImportService.addFileToSnapshot(
        input,
        ctx.buildKnownSshDuplicateKeys(),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.xshell.addFolderToSnapshot,
    async (_event, input: XshellSnapshotFolderInput) => {
      return ctx.xshellImportService.addFolderToSnapshot(
        input,
        ctx.buildKnownSshDuplicateKeys(),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.termius.discardSnapshot,
    async (_event, snapshotId: string) => {
      ctx.termiusImportService.discardSnapshot(snapshotId);
    },
  );

  ipcMain.handle(
    ipcChannels.xshell.discardSnapshot,
    async (_event, snapshotId: string) => {
      ctx.xshellImportService.discardSnapshot(snapshotId);
    },
  );

  ipcMain.handle(
    ipcChannels.openssh.discardSnapshot,
    async (_event, snapshotId: string) => {
      ctx.opensshImportService.discardSnapshot(snapshotId);
    },
  );

  ipcMain.handle(
    ipcChannels.termius.importSelection,
    async (_event, input: TermiusImportSelectionInput) => {
      const snapshot = ctx.termiusImportService.getSnapshot(input.snapshotId);
      if (!snapshot) {
        throw new Error(
          "Termius import snapshot을 찾지 못했습니다. 목록을 다시 불러와 주세요.",
        );
      }

      const result = await importTermiusSelection(snapshot, input, {
        groups: ctx.groups,
        hosts: ctx.hosts,
        activityLogs: ctx.activityLogs,
        secretMetadata: ctx.secretMetadata,
        persistSecret: async (label, secrets) =>
          ctx.persistImportedSecret(label, secrets),
        queueSync: ctx.queueSync,
      });

      if (result.warnings.length > 0) {
        ctx.activityLogs.append(
          "warn",
          "audit",
          "Termius import 중 일부 항목을 건너뛰거나 경고가 발생했습니다.",
          {
            warningCount: result.warnings.length,
          },
        );
      }

      ctx.termiusImportService.discardSnapshot(input.snapshotId);
      return result;
    },
  );

  ipcMain.handle(
    ipcChannels.openssh.importSelection,
    async (_event, input: OpenSshImportSelectionInput) => {
      const snapshot = ctx.opensshImportService.getSnapshot(input.snapshotId);
      if (!snapshot) {
        throw new Error(
          "OpenSSH 가져오기 상태를 찾을 수 없습니다. 다시 파일을 선택해 주세요.",
        );
      }

      try {
        const selectedHostKeys = new Set(input.selectedHostKeys);
        const selectedHosts = [...snapshot.hostsByKey.values()].filter((host) =>
          selectedHostKeys.has(host.key),
        );
        const targetGroupPath = normalizeGroupPath(input.groupPath);
        const existingGroupPaths = new Set(
          ctx.groups.list().map((group) => group.path),
        );
        const secretRefsByIdentityPath = new Map<string, string>();
        const warnings: OpenSshImportWarning[] = [...snapshot.warnings];

        let createdGroupCount = 0;
        let createdHostCount = 0;
        let createdSecretCount = 0;
        let skippedHostCount = 0;

        for (const candidatePath of buildTermiusGroupAncestorPaths(targetGroupPath)) {
          if (existingGroupPaths.has(candidatePath)) {
            continue;
          }
          const group = ctx.groups.create(
            randomUUID(),
            getGroupLabel(candidatePath),
            getParentGroupPath(candidatePath),
          );
          existingGroupPaths.add(group.path);
          createdGroupCount += 1;
        }

        for (const host of selectedHosts) {
          let secretRef: string | null = null;

          if (host.authType === "privateKey" && host.identityFilePath) {
            const cachedSecretRef = secretRefsByIdentityPath.get(host.identityFilePath);
            if (cachedSecretRef) {
              secretRef = cachedSecretRef;
            } else {
              const identityImport = await resolveOpenSshIdentityImport(
                host.identityFilePath,
              );
              if (identityImport.kind === "managed-key") {
                secretRef = await ctx.persistImportedSecret(`OpenSSH ${host.alias}`, {
                  privateKeyPem: identityImport.privateKeyPem,
                });
                if (secretRef) {
                  secretRefsByIdentityPath.set(host.identityFilePath, secretRef);
                  createdSecretCount += 1;
                }
              } else {
                warnings.push(identityImport.warning);
                skippedHostCount += 1;
                continue;
              }
            }
          }

          ctx.hosts.create(
            randomUUID(),
            {
              kind: "ssh",
              label: host.alias,
              groupName: targetGroupPath,
              tags: [],
              terminalThemeId: null,
              hostname: host.hostname,
              port: host.port,
              username: host.username,
              authType: host.authType,
            },
            secretRef,
          );
          createdHostCount += 1;
        }

        if (
          createdGroupCount > 0 ||
          createdHostCount > 0 ||
          createdSecretCount > 0
        ) {
          ctx.activityLogs.append(
            "info",
            "audit",
            "OpenSSH 소스에서 호스트를 가져왔습니다.",
            {
              sourceCount: snapshot.sources.length,
              targetGroupPath,
              createdGroupCount,
              createdHostCount,
              createdSecretCount,
              skippedHostCount,
            },
          );
          ctx.queueSync();
        }

        if (warnings.length > 0) {
          ctx.activityLogs.append(
            "warn",
            "audit",
            "OpenSSH 가져오기가 경고와 함께 완료되었습니다.",
            {
              sourceCount: snapshot.sources.length,
              warningCount: warnings.length,
            },
          );
        }

        return {
          createdHostCount,
          createdSecretCount,
          skippedHostCount,
          warnings,
        };
      } finally {
        ctx.opensshImportService.discardSnapshot(input.snapshotId);
      }
    },
  );

  ipcMain.handle(
    ipcChannels.xshell.importSelection,
    async (_event, input: XshellImportSelectionInput) => {
      const snapshot = ctx.xshellImportService.getSnapshot(input.snapshotId);
      if (!snapshot) {
        throw new Error(
          "Xshell 가져오기 상태를 찾지 못했습니다. 대화상자를 다시 열어주세요.",
        );
      }

      try {
        const selectedHosts = collectSelectedXshellHosts(snapshot, input);
        const selectedGroupPaths = collectSelectedXshellGroupPaths(
          snapshot,
          input,
        );
        const existingGroupPaths = new Set(
          ctx.groups.list().map((group) => group.path),
        );
        const passwordSecurityContext =
          await resolveCurrentXshellPasswordSecurityContext();
        const warnings: XshellImportWarning[] = [...snapshot.warnings];
        let createdGroupCount = 0;
        let createdHostCount = 0;
        let createdSecretCount = 0;
        let skippedHostCount = 0;

        for (const groupPath of selectedGroupPaths) {
          for (const candidatePath of buildTermiusGroupAncestorPaths(groupPath)) {
            if (existingGroupPaths.has(candidatePath)) {
              continue;
            }
            const group = ctx.groups.create(
              randomUUID(),
              getGroupLabel(candidatePath),
              getParentGroupPath(candidatePath),
            );
            existingGroupPaths.add(group.path);
            createdGroupCount += 1;
          }
        }

        for (const host of selectedHosts) {
          const groupPath = normalizeGroupPath(host.groupPath);
          for (const candidatePath of buildTermiusGroupAncestorPaths(groupPath)) {
            if (existingGroupPaths.has(candidatePath)) {
              continue;
            }
            ctx.groups.create(
              randomUUID(),
              getGroupLabel(candidatePath),
              getParentGroupPath(candidatePath),
            );
            existingGroupPaths.add(candidatePath);
            createdGroupCount += 1;
          }

          let secretRef: string | null = null;
          if (host.authType === "privateKey") {
            if (!host.privateKeyPath) {
              warnings.push({
                code: "private-key-import-failed",
                message: `${host.label}: 개인키 파일 경로를 찾지 못해 호스트를 가져오지 않았습니다.`,
                filePath: host.sourceFilePath,
              });
              skippedHostCount += 1;
              continue;
            }
            const identityImport = await resolveOpenSshIdentityImport(
              host.privateKeyPath,
            );
            if (identityImport.kind !== "managed-key") {
              warnings.push({
                ...identityImport.warning,
                message: `${host.label}: ${identityImport.warning.message}`,
                filePath: host.sourceFilePath,
              });
              skippedHostCount += 1;
              continue;
            }
            secretRef = await ctx.persistImportedSecret(`Xshell • ${host.label}`, {
              privateKeyPem: identityImport.privateKeyPem,
            });
            if (secretRef) {
              createdSecretCount += 1;
            } else {
              warnings.push({
                code: "private-key-import-failed",
                message: `${host.label}: 개인키를 저장하지 못해 호스트를 가져오지 않았습니다.`,
                filePath: host.sourceFilePath,
              });
              skippedHostCount += 1;
              continue;
            }
          }

          if (
            host.authType === "password" &&
            host.encryptedPassword &&
            !host.masterPasswordEnabled
          ) {
            const decryptedPassword = decryptXshellPassword({
              encryptedPassword: host.encryptedPassword,
              sessionFileVersion: host.sessionFileVersion,
              masterPasswordEnabled: host.masterPasswordEnabled,
              securityContext: passwordSecurityContext,
            });

            if (decryptedPassword.ok) {
              secretRef = await ctx.persistImportedSecret(`Xshell • ${host.label}`, {
                password: decryptedPassword.password,
              });
              if (secretRef) {
                createdSecretCount += 1;
              }
            } else {
              const warningCode =
                decryptedPassword.reason === "missing-security-context" ||
                decryptedPassword.reason === "invalid-version"
                  ? "password-import-unsupported"
                  : "password-decrypt-failed";
              warnings.push({
                code: warningCode,
                message:
                  warningCode === "password-import-unsupported"
                    ? `${host.label}: 이 Windows 사용자 환경에서는 저장된 Xshell 비밀번호를 자동으로 가져올 수 없습니다.`
                    : `${host.label}: 저장된 Xshell 비밀번호를 복호화하지 못해 호스트만 가져왔습니다.`,
                filePath: host.sourceFilePath,
              });
            }
          }

          ctx.hosts.create(
            randomUUID(),
            {
              kind: "ssh",
              label: host.label,
              groupName: groupPath,
              tags: [],
              terminalThemeId: null,
              hostname: host.hostname,
              port: host.port,
              username: host.username,
              authType: host.authType,
            },
            secretRef,
          );
          createdHostCount += 1;
        }

        if (
          createdGroupCount > 0 ||
          createdHostCount > 0 ||
          createdSecretCount > 0
        ) {
          ctx.activityLogs.append(
            "info",
            "audit",
            "Xshell 세션에서 호스트를 가져왔습니다.",
            {
              sourceCount: snapshot.sources.length,
              createdGroupCount,
              createdHostCount,
              createdSecretCount,
              skippedHostCount,
            },
          );
          ctx.queueSync();
        }

        if (warnings.length > 0) {
          ctx.activityLogs.append(
            "warn",
            "audit",
            "Xshell 가져오기가 경고와 함께 완료되었습니다.",
            {
              sourceCount: snapshot.sources.length,
              warningCount: warnings.length,
            },
          );
        }

        return {
          createdGroupCount,
          createdHostCount,
          createdSecretCount,
          skippedHostCount,
          warnings,
        };
      } finally {
        ctx.xshellImportService.discardSnapshot(input.snapshotId);
      }
    },
  );
}
