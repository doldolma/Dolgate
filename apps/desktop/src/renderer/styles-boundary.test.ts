import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rendererDir = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.join(rendererDir, 'styles');
const semanticClassFreeFiles = [
  'components/LoginGate.tsx',
  'components/AppTitleBar.tsx',
  'components/AwsImportDialog.tsx',
  'components/OpenSshImportDialog.tsx',
  'components/TermiusImportDialog.tsx',
  'components/XshellImportDialog.tsx',
  'components/WarpgateImportDialog.tsx',
  'components/HostBrowser.tsx',
  'components/HostDrawer.tsx',
  'components/HostForm.tsx',
  'components/HomeNavigation.tsx',
  'components/SettingsPanel.tsx',
  'components/LogsPanel.tsx',
  'components/SessionReplayWindow.tsx',
  'components/SessionShareChatWindow.tsx',
  'shells/LoginShell.tsx',
  'shells/AppShell.tsx',
  'shells/HomeShell.tsx',
  'shells/ContainersShell.tsx',
];
const operationalChromeFiles = [
  'components/AwsEcsWorkspace.tsx',
  'components/SftpWorkspace.tsx',
  'components/LogsPanel.tsx',
  'components/PortForwardingPanel.tsx',
  'components/ContainersWorkspace.tsx',
  'components/terminal-workspace/TerminalSharePopover.tsx',
  'components/terminal-workspace/TerminalInteractiveAuthOverlay.tsx',
  'components/terminal-workspace/TerminalConnectionOverlay.tsx',
  'components/terminal-workspace/TerminalWorkspaceLayoutView.tsx',
];
const generalBannedSemanticClasses = [
  'primary-button',
  'secondary-button',
  'section-kicker',
  'eyebrow',
  'empty-callout',
  'status-pill',
];
const operationalBannedSemanticClasses = [
  'primary-button',
  'secondary-button',
  'status-pill',
  'empty-callout',
  'section-kicker',
  'eyebrow',
  'workspace-tab',
  'titlebar-action',
  'operations-tab',
  'operations-panel',
  'ghost-button',
  'modal-card',
];
const miscDisallowedSelectors = [
  '.workspace-tab__status',
  '.operations-panel__header',
  '.operations-card',
  '.operations-card__actions',
  '.modal-card__header',
  '.modal-card__footer',
  '.terminal-workspace__broadcast-control',
  '.terminal-session',
  '.terminal-search-overlay',
  '.sftp-workspace__panes',
  '.sftp-transfer-gutter',
  '.containers-shell__tabs',
  '.containers-shell__tab-shell',
  '.containers-shell__content',
  '.sftp-modal input',
  '.sftp-modal select',
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsStandaloneClassToken(source: string, classToken: string) {
  return new RegExp(`\\b${escapeRegExp(classToken)}\\b`).test(source);
}

describe('renderer style boundaries', () => {
  it('keeps tailwind.css as an entry/base stylesheet', () => {
    const source = fs.readFileSync(path.join(stylesDir, 'tailwind.css'), 'utf8');

    expect(source).toContain('@import "tailwindcss";');
    expect(source).not.toContain('@layer components');
  });

  it('keeps legacy.css as an import-only widget aggregator', () => {
    const source = fs.readFileSync(path.join(stylesDir, 'legacy.css'), 'utf8');
    const importLines = source
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    expect(importLines).toEqual([
      '@import "./legacy/misc.css";',
      '@import "./legacy/terminal.css";',
      '@import "./legacy/sftp.css";',
      '@import "./legacy/containers.css";',
      '@import "./legacy/port-forwarding.css";',
    ]);
  });

  it('keeps misc.css focused on app-level shared styles', () => {
    const source = fs.readFileSync(path.join(stylesDir, 'legacy', 'misc.css'), 'utf8');

    for (const selector of miscDisallowedSelectors) {
      expect(source).not.toContain(selector);
    }
  });

  it('keeps general UI files free of banned legacy semantic classes', () => {
    for (const relativeFile of semanticClassFreeFiles) {
      const source = fs.readFileSync(path.join(rendererDir, relativeFile), 'utf8');
      for (const bannedClass of generalBannedSemanticClasses) {
        expect(
          containsStandaloneClassToken(source, bannedClass),
          `${relativeFile} should not use ${bannedClass}`,
        ).toBe(false);
      }
    }
  });

  it('keeps migrated operational chrome files free of legacy shell classes', () => {
    for (const relativeFile of operationalChromeFiles) {
      const source = fs.readFileSync(path.join(rendererDir, relativeFile), 'utf8');
      for (const bannedClass of operationalBannedSemanticClasses) {
        expect(
          containsStandaloneClassToken(source, bannedClass),
          `${relativeFile} should not use ${bannedClass}`,
        ).toBe(false);
      }
    }
  });
});
