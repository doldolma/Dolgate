import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rendererDir = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.join(rendererDir, 'styles');
const legacyCssPath = path.join(stylesDir, 'legacy.css');
const legacyDir = path.join(stylesDir, 'legacy');
const semanticClassFreeFiles = [
  'components/DesktopWindowControls.tsx',
  'components/LoginGate.tsx',
  'components/AppTitleBar.tsx',
  'components/AwsImportDialog.tsx',
  'components/KeychainPanel.tsx',
  'components/KnownHostsPanel.tsx',
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
  'shells/SftpShell.tsx',
];
const phaseSevenZeroLegacyFiles = [
  'components/LoginGate.tsx',
  'components/DesktopWindowControls.tsx',
  'components/AppTitleBar.tsx',
  'components/AwsImportDialog.tsx',
  'components/AwsSftpConfigRetryDialog.tsx',
  'components/CredentialRetryDialog.tsx',
  'components/HomeNavigation.tsx',
  'components/HostBrowser.tsx',
  'components/HostDrawer.tsx',
  'components/HostForm.tsx',
  'components/KnownHostPromptDialog.tsx',
  'components/MissingUsernameDialog.tsx',
  'components/OpenSshImportDialog.tsx',
  'components/SecretEditDialog.tsx',
  'components/SettingsPanel.tsx',
  'components/SessionReplayWindow.tsx',
  'components/SessionShareChatWindow.tsx',
  'components/SftpWorkspace.tsx',
  'components/TermiusImportDialog.tsx',
  'components/UpdateInstallConfirmDialog.tsx',
  'components/WarpgateImportDialog.tsx',
  'components/XshellImportDialog.tsx',
  'shells/LoginShell.tsx',
  'shells/AppShell.tsx',
  'shells/HomeShell.tsx',
  'shells/SessionShell.tsx',
];
const phaseSevenBannedPrefixes = [
  'app-frame',
  'login-window-chrome',
  'login-gate',
  'app-titlebar',
  'titlebar-tabs',
  'window-control',
  'session-shell',
  'split-button',
  'navigation-item',
  'home-toolbar',
  'home-modal',
  'browser-section',
  'group-card',
  'host-grid',
  'host-drawer',
  'host-form',
  'tag-token',
  'context-menu',
  'aws-import-dialog',
  'termius-import-dialog',
  'xshell-import-dialog',
  'openssh-import-dialog',
  'warpgate-import-dialog',
  'credential-retry-dialog',
  'known-host-dialog',
  'update-install-dialog',
  'secret-edit-dialog',
  'log-details',
  'logs-lifecycle-card',
  'host-browser-card',
  'host-browser__',
  'settings-panel',
  'settings-card',
  'session-share-chat-window',
  'session-replay-window__',
  'sftp-host-picker__results',
  'sftp-host-picker__spinner',
];
const phaseSevenAllowedTokensByFile: Partial<Record<string, string[]>> = {
  'components/SessionReplayWindow.tsx': ['session-replay-window__scrubber'],
  'components/HostBrowser.tsx': ['data-group-card', 'data-host-grid', 'data-group-grid'],
  'components/SftpWorkspace.tsx': ['data-group-card', 'data-host-grid', 'data-group-grid'],
};
const operationalChromeFiles = [
  'components/AwsEcsWorkspace.tsx',
  'components/SftpWorkspace.tsx',
  'components/LogsPanel.tsx',
  'components/PortForwardingPanel.tsx',
  'components/ContainersWorkspace.tsx',
  'components/UPlotMetricChart.tsx',
  'components/TerminalWorkspace.tsx',
  'components/terminal-workspace/TerminalChatToastRegion.tsx',
  'components/terminal-workspace/TerminalPaneHeader.tsx',
  'components/terminal-workspace/TerminalSearchOverlay.tsx',
  'components/terminal-workspace/TerminalSessionPane.tsx',
  'components/terminal-workspace/TerminalSharePopover.tsx',
  'components/terminal-workspace/TerminalInteractiveAuthOverlay.tsx',
  'components/terminal-workspace/TerminalConnectionOverlay.tsx',
  'components/terminal-workspace/TerminalWorkspaceLayoutView.tsx',
  'shells/OfflineModeBanner.tsx',
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
  'sftp-pane__toolbar',
  'sftp-source-toggle',
  'sftp-breadcrumbs',
  'sftp-filter-row',
  'sftp-host-picker__overlay',
  'sftp-modal',
  'sftp-pane__content--browser',
  'sftp-pane__warnings',
  'sftp-table-shell',
  'sftp-table',
  'sftp-table__header-cell',
  'sftp-table__header-label',
  'sftp-entry-name',
  'sftp-entry-icon',
  'sftp-entry-label',
  'sftp-loading-indicator',
  'sftp-inline-button',
  'sftp-transfer-bar',
  'sftp-transfer-arrow',
  'sftp-transfer-gutter',
  'sftp-permissions-grid',
  'sftp-permissions-toggle',
  'sftp-permissions-preview',
  'transfer-card',
  'terminal-warning-banner',
  'containers-workspace__header',
  'containers-workspace__header-actions',
  'containers-workspace__sidebar',
  'containers-workspace__detail',
  'containers-workspace__logs-toolbar',
  'containers-workspace__detail-actions',
  'containers-workspace__action-row',
  'containers-workspace__host-meta',
  'containers-workspace__list-item',
  'containers-workspace__summary-card',
  'containers-workspace__section-card',
  'containers-workspace__logs',
  'containers-workspace__follow-toggle',
  'containers-workspace__metric-chart-card',
  'ecs-workspace__warning',
  'ecs-workspace__summary-card',
  'ecs-workspace__service-list-shell',
  'ecs-workspace__picker',
  'ecs-workspace__service-row',
  'ecs-workspace__detail-shell',
  'ecs-workspace__range-',
  'ecs-workspace__tunnel-runtime-card',
  'operations-card',
  'port-forwarding-modal',
  'terminal-setting-field',
  'terminal-setting-toggle',
  'terminal-theme-option',
  'terminal-empty',
  'terminal-workspace__broadcast-control',
  'terminal-workspace__broadcast-toggle',
  'terminal-workspace__broadcast-tooltip',
  'terminal-error-banner',
  'terminal-status-banner',
  'terminal-interactive-auth',
  'empty-state-card',
  'empty-steps',
  'terminal-pane-header',
  'terminal-session',
  'terminal-search-overlay',
  'terminal-share-anchor',
  'terminal-share-button',
  'terminal-share-popover',
  'terminal-share-chat-toast',
  'terminal-connection-overlay',
  'titlebar-actions',
  'session-replay-window__terminal-shell',
  'app-offline-banner',
  'port-forward-picker',
  'port-forward-native-select',
  'port-forward-local-port',
  'port-forward-toggle',
  'form-field',
  'form-error',
];
const miscDisallowedSelectors = [
  '.app-frame',
  '.app-frame--login',
  '.login-window-chrome',
  '.app-titlebar',
  '.titlebar-tabs',
  '.titlebar-spacer',
  '.desktop-window-controls',
  '.window-control',
  '.update-menu',
  '.update-popover',
  '.workspace-shell',
  '.home-shell',
  '.home-navigation',
  '.navigation-item',
  '.home-main',
  '.home-toolbar',
  '.home-modal',
  '.login-gate',
  '.session-shell',
  '.split-button',
  '.browser-section',
  '.group-grid',
  '.group-card',
  '.host-grid',
  '.context-menu',
  '.host-drawer',
  '.host-form__',
  '.aws-import-dialog',
  '.termius-import-dialog',
  '.xshell-import-dialog',
  '.openssh-import-dialog',
  '.warpgate-import-dialog',
  '.credential-retry-dialog',
  '.known-host-dialog',
  '.update-install-dialog',
  '.secret-edit-dialog',
  '.log-details',
  '.logs-lifecycle-card',
  '.host-browser__',
  '.host-browser-card',
  '.settings-panel',
  '.settings-card',
  '.settings-account-summary',
  '.session-share-chat-window',
  '.session-replay-window__header',
  '.session-replay-window__summary',
  '.session-replay-window__controls',
  '.session-replay-window__zoom',
  '.session-replay-window__speed',
  '.session-replay-window__terminal',
  '.operations-list',
  '.operations-section',
  '.operations-section__title',
  '.logs-toolbar',
  '.form-field--compact',
  '.form-field',
  '.form-error',
  '.workspace-tab__status',
  '.operations-panel__header',
  '.operations-card',
  '.operations-card__actions',
  '.modal-card__header',
  '.modal-card__footer',
  '.terminal-workspace__broadcast-control',
  '.terminal-workspace__broadcast-toggle',
  '.terminal-workspace__broadcast-tooltip',
  '.terminal-workspace',
  '.terminal-empty',
  '.terminal-session',
  '.terminal-search-overlay',
  '.terminal-error-banner',
  '.terminal-status-banner',
  '.terminal-interactive-auth',
  '.empty-state-card',
  '.empty-steps',
  '.aws-import-dialog__loading',
  '.sftp-workspace__panes',
  '.sftp-transfer-gutter',
  '.containers-shell__tabs',
  '.containers-shell__tab-shell',
  '.containers-shell__content',
  '.sftp-shell',
  '.sftp-shell__content',
  '.sftp-modal input',
  '.sftp-modal select',
  '.titlebar-actions',
  '.terminal-settings-grid',
  '.terminal-setting-field',
  '.terminal-setting-toggle',
  '.terminal-theme-header',
  '.theme-options',
  '.theme-option',
  '.terminal-theme-option',
  '.home-main > .app-offline-banner',
];

const sftpDisallowedSelectors = [
  '.app-offline-banner',
  '.sftp-workspace',
  '.sftp-workspace__panes',
  '.sftp-pane',
  '.sftp-pane__header',
  '.sftp-pane__header-main',
  '.sftp-pane__disconnect',
  '.sftp-pane__content',
  '.sftp-host-picker',
  '.sftp-host-picker__results',
  '.sftp-host-picker__spinner',
  '.sftp-host-picker .host-browser-card',
  '.sftp-host-picker .host-grid',
  '.sftp-host-picker .group-grid',
  '.sftp-host-picker .group-card.disabled',
  '.sftp-pane__toolbar',
  '.sftp-source-toggle',
  '.sftp-breadcrumbs',
  '.sftp-filter-row',
  '.sftp-host-picker__overlay',
  '.sftp-modal',
  '.sftp-modal-backdrop',
  '.sftp-pane__content--browser',
  '.sftp-pane__warnings',
  '.sftp-table-shell',
  '.sftp-table',
  '.sftp-table__header-cell',
  '.sftp-table__header-label',
  '.sftp-entry-name',
  '.sftp-entry-icon',
  '.sftp-entry-label',
  '.sftp-loading-indicator',
  '.sftp-inline-button',
  '.sftp-transfer-bar',
  '.sftp-transfer-arrow',
  '.sftp-transfer-gutter',
  '.sftp-permissions-grid',
  '.sftp-permissions-toggle',
  '.sftp-permissions-preview',
  '.transfer-card',
  '.transfer-card__top',
  '.transfer-card__meta',
  '.transfer-card__actions',
  '.transfer-card__progress',
  '.terminal-warning-banner',
  '.sftp-column-resize-handle',
  '@keyframes sftp-spinner',
];

const containersDisallowedSelectors = [
  '.containers-workspace__header',
  '.containers-workspace__header-actions',
  '.containers-workspace__sidebar',
  '.containers-workspace__detail',
  '.containers-workspace__logs-toolbar',
  '.containers-workspace__detail-actions',
  '.containers-workspace__action-row',
  '.containers-workspace__host-meta',
  '.containers-workspace__list-item',
  '.containers-workspace__summary-card',
  '.containers-workspace__section-card',
  '.containers-workspace__logs',
  '.containers-workspace__follow-toggle',
  '.containers-workspace__metric-chart-card',
  '.containers-workspace__metric-chart-header',
  '.containers-workspace__metric-plot-shell',
  '.containers-workspace__metric-plot',
  '.containers-workspace__metric-tooltip',
  '.containers-workspace__metric-tooltip-row',
  '.containers-workspace__metric-tooltip-swatch',
  '.containers-workspace__log-row',
  '.containers-workspace__log-message',
  '.containers-workspace__log-timestamp',
  '.containers-workspace__log-segment',
  '.containers-workspace__empty-detail',
  '.containers-workspace__tunnel-runtime-card',
  '.containers-workspace__tunnel-runtime-grid',
  '.containers-workspace__tunnel-actions',
  '.ecs-workspace__warning',
  '.ecs-workspace__summary-card',
  '.ecs-workspace__service-list-shell',
  '.ecs-workspace__picker',
  '.ecs-workspace__service-row',
  '.ecs-workspace__detail-shell',
  '.ecs-workspace__range-',
  '.ecs-workspace__tunnel-runtime-card',
];

const portForwardingDisallowedSelectors = [
  '.operations-card',
  '.port-forwarding-modal',
  '.port-forward-picker',
  '.port-forward-native-select',
  '.port-forward-local-port',
  '.port-forward-toggle',
];

const terminalDisallowedSelectors = [
  '.terminal-workspace',
  '.terminal-empty',
  '.terminal-workspace__broadcast-control',
  '.terminal-workspace__broadcast-toggle',
  '.terminal-workspace__broadcast-tooltip',
  '.terminal-error-banner',
  '.terminal-status-banner',
  '.terminal-interactive-auth',
  '.empty-state-card',
  '.empty-steps',
  '.aws-import-dialog__loading',
  '.terminal-session',
  '.terminal-share-anchor',
  '.terminal-share-chat-toast',
  '.terminal-share-button',
  '.terminal-share-popover',
  '.terminal-pane-header',
  '.terminal-search-overlay',
  '.terminal-connection-overlay',
  '.terminal-session--pane .terminal-canvas',
];

const zeroLegacyWrapperFiles = [
  'components/AwsImportDialog.tsx',
  'components/KeychainPanel.tsx',
  'components/KnownHostsPanel.tsx',
  'components/LogsPanel.tsx',
  'components/PortForwardingPanel.tsx',
  'components/WarpgateImportDialog.tsx',
  'shells/ContainersShell.tsx',
  'shells/SftpShell.tsx',
];
const zeroLegacyWrapperClasses = [
  'operations-list',
  'operations-section',
  'operations-section__title',
  'logs-toolbar',
  'form-field--compact',
  'containers-shell__tabs',
  'containers-shell__tab-shell',
  'containers-shell__tab',
  'containers-shell__tab-badge',
  'containers-shell__tab-close',
  'containers-shell__content',
  'containers-shell__empty-state',
  'sftp-shell',
  'sftp-shell__content',
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsStandaloneClassToken(source: string, classToken: string) {
  return new RegExp(`\\b${escapeRegExp(classToken)}\\b`).test(source);
}

function stripAllowedTokens(source: string, allowedTokens: string[]) {
  return allowedTokens.reduce(
    (current, token) => current.split(token).join(''),
    source,
  );
}

describe('renderer style boundaries', () => {
  it('keeps tailwind.css as an entry/base stylesheet', () => {
    const source = fs.readFileSync(path.join(stylesDir, 'tailwind.css'), 'utf8');

    expect(source).toContain('@import "tailwindcss";');
    expect(source).not.toContain('@layer components');
  });

  it('defines global scrollbar styling with terminal and native opt-outs', () => {
    const source = fs.readFileSync(path.join(stylesDir, 'tailwind.css'), 'utf8');

    expect(source).toContain('::-webkit-scrollbar');
    expect(source).toContain('scrollbar-width: thin;');
    expect(source).toContain('[data-native-scrollbar="true"]');
    expect(source).toContain('[data-terminal-canvas="true"]');
    expect(source).toContain('.xterm-viewport');
    expect(source).toContain('scrollbar-color: auto;');
  });

  it('defines scrollbar theme tokens for light and dark themes', () => {
    const source = fs.readFileSync(path.join(stylesDir, 'tokens.css'), 'utf8');
    const scrollbarTokens = [
      '--scrollbar-size',
      '--scrollbar-radius',
      '--scrollbar-track',
      '--scrollbar-thumb',
      '--scrollbar-thumb-hover',
      '--scrollbar-thumb-active',
      '--scrollbar-corner',
    ];

    for (const token of scrollbarTokens) {
      expect(source.match(new RegExp(`${escapeRegExp(token)}:`, 'g'))?.length ?? 0).toBe(2);
    }
  });

  it('removes legacy.css imports from renderer entrypoints', () => {
    const mainSource = fs.readFileSync(path.join(rendererDir, 'main.tsx'), 'utf8');
    const indexSource = fs.readFileSync(path.join(stylesDir, 'index.css'), 'utf8');

    expect(mainSource).not.toContain("import './styles/legacy.css';");
    expect(indexSource).not.toContain("@import './legacy.css';");
  });

  it('removes renderer legacy stylesheet files', () => {
    expect(fs.existsSync(legacyCssPath)).toBe(false);
    const remainingLegacyCssFiles = fs.existsSync(legacyDir)
      ? fs
          .readdirSync(legacyDir)
          .filter((fileName) => fileName.endsWith('.css'))
      : [];

    expect(remainingLegacyCssFiles).toEqual([]);
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

  it('keeps zero-legacy wrapper files free of migrated wrapper classes', () => {
    for (const relativeFile of zeroLegacyWrapperFiles) {
      const source = fs.readFileSync(path.join(rendererDir, relativeFile), 'utf8');
      for (const bannedClass of zeroLegacyWrapperClasses) {
        expect(
          containsStandaloneClassToken(source, bannedClass),
          `${relativeFile} should not use ${bannedClass}`,
        ).toBe(false);
      }
    }
  });

  it('keeps phase 7 app/common UI files free of migrated legacy prefix families', () => {
    for (const relativeFile of phaseSevenZeroLegacyFiles) {
      const source = fs.readFileSync(path.join(rendererDir, relativeFile), 'utf8');
      const strippedSource = stripAllowedTokens(
        source,
        phaseSevenAllowedTokensByFile[relativeFile] ?? [],
      );
      for (const bannedPrefix of phaseSevenBannedPrefixes) {
        expect(
          strippedSource.includes(bannedPrefix),
          `${relativeFile} should not include ${bannedPrefix}`,
        ).toBe(false);
      }
    }
  });
});
