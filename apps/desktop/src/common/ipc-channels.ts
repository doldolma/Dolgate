export const ipcChannels = {
  auth: {
    getState: 'auth:get-state',
    bootstrap: 'auth:bootstrap',
    retryOnline: 'auth:retry-online',
    beginBrowserLogin: 'auth:begin-browser-login',
    reopenBrowserLogin: 'auth:reopen-browser-login',
    cancelBrowserLogin: 'auth:cancel-browser-login',
    logout: 'auth:logout',
    event: 'auth:event'
  },
  sync: {
    bootstrap: 'sync:bootstrap',
    pushDirty: 'sync:push-dirty',
    status: 'sync:status',
    exportDecryptedSnapshot: 'sync:export-decrypted-snapshot'
  },
  bootstrap: {
    getInitialSnapshot: 'bootstrap:get-initial-snapshot',
    getSyncedWorkspaceSnapshot: 'bootstrap:get-synced-workspace-snapshot'
  },
  hosts: {
    list: 'hosts:list',
    create: 'hosts:create',
    update: 'hosts:update',
    remove: 'hosts:remove',
    setFavorite: 'hosts:set-favorite'
  },
  groups: {
    list: 'groups:list',
    create: 'groups:create',
    remove: 'groups:remove',
    move: 'groups:move',
    rename: 'groups:rename'
  },
  aws: {
    listProfiles: 'aws:list-profiles',
    listExternalProfiles: 'aws:list-external-profiles',
    createProfile: 'aws:create-profile',
    prepareSsoProfile: 'aws:prepare-sso-profile',
    getProfileDetails: 'aws:get-profile-details',
    getExternalProfileDetails: 'aws:get-external-profile-details',
    importExternalProfiles: 'aws:import-external-profiles',
    updateProfile: 'aws:update-profile',
    updateProfileRegion: 'aws:update-profile-region',
    renameProfile: 'aws:rename-profile',
    deleteProfile: 'aws:delete-profile',
    getProfileStatus: 'aws:get-profile-status',
    login: 'aws:login',
    listRegions: 'aws:list-regions',
    listEc2Instances: 'aws:list-ec2-instances',
    listEcsClusters: 'aws:list-ecs-clusters',
    loadEcsClusterSnapshot: 'aws:load-ecs-cluster-snapshot',
    loadEcsClusterUtilization: 'aws:load-ecs-cluster-utilization',
    loadEcsServiceActionContext: 'aws:load-ecs-service-action-context',
    loadEcsServiceLogs: 'aws:load-ecs-service-logs',
    openEcsExecShell: 'aws:open-ecs-exec-shell',
    startEcsServiceTunnel: 'aws:start-ecs-service-tunnel',
    stopEcsServiceTunnel: 'aws:stop-ecs-service-tunnel',
    listEcsTaskTunnelServices: 'aws:list-ecs-task-tunnel-services',
    loadEcsTaskTunnelService: 'aws:load-ecs-task-tunnel-service',
    inspectHostSshMetadata: 'aws:inspect-host-ssh-metadata',
    loadHostSshMetadata: 'aws:load-host-ssh-metadata'
  },
  warpgate: {
    testConnection: 'warpgate:test-connection',
    getConnectionInfo: 'warpgate:get-connection-info',
    listSshTargets: 'warpgate:list-ssh-targets',
    startBrowserImport: 'warpgate:start-browser-import',
    cancelBrowserImport: 'warpgate:cancel-browser-import',
    event: 'warpgate:event'
  },
  termius: {
    probeLocal: 'termius:probe-local',
    importSelection: 'termius:import-selection',
    discardSnapshot: 'termius:discard-snapshot'
  },
  openssh: {
    probeDefault: 'openssh:probe-default',
    addFileToSnapshot: 'openssh:add-file-to-snapshot',
    importSelection: 'openssh:import-selection',
    discardSnapshot: 'openssh:discard-snapshot'
  },
  xshell: {
    probeDefault: 'xshell:probe-default',
    addFolderToSnapshot: 'xshell:add-folder-to-snapshot',
    importSelection: 'xshell:import-selection',
    discardSnapshot: 'xshell:discard-snapshot'
  },
  ssh: {
    connect: 'ssh:connect',
    connectLocal: 'ssh:connect-local',
    write: 'ssh:write',
    writeBinary: 'ssh:write-binary',
    resize: 'ssh:resize',
    disconnect: 'ssh:disconnect',
    prepareAutocomplete: 'ssh:autocomplete-prepare',
    installShellIntegration: 'ssh:install-shell-integration',
    refreshAutocomplete: 'ssh:autocomplete-refresh',
    stopAutocomplete: 'ssh:autocomplete-stop',
    completionQuery: 'ssh:completion-query',
    respondKeyboardInteractive: 'ssh:respond-keyboard-interactive',
    probeAgent: 'ssh:probe-agent',
    tmuxSplitPane: 'ssh:tmux-split-pane',
    tmuxNewWindow: 'ssh:tmux-new-window',
    tmuxSelectWindow: 'ssh:tmux-select-window',
    tmuxSelectPane: 'ssh:tmux-select-pane',
    tmuxKillPane: 'ssh:tmux-kill-pane',
    tmuxKillWindow: 'ssh:tmux-kill-window',
    tmuxKillSession: 'ssh:tmux-kill-session',
    tmuxRenameWindow: 'ssh:tmux-rename-window',
    tmuxDetach: 'ssh:tmux-detach',
    tmuxCommand: 'ssh:tmux-command',
    event: 'ssh:core-event',
    data: 'ssh:stream-data'
  },
  serial: {
    connect: 'serial:connect',
    listPorts: 'serial:list-ports',
    control: 'serial:control',
  },
  sessionShares: {
    start: 'session-shares:start',
    updateSnapshot: 'session-shares:update-snapshot',
    setInputEnabled: 'session-shares:set-input-enabled',
    stop: 'session-shares:stop',
    openOwnerChatWindow: 'session-shares:open-owner-chat-window',
    sendOwnerChatMessage: 'session-shares:send-owner-chat-message',
    getOwnerChatSnapshot: 'session-shares:get-owner-chat-snapshot',
    event: 'session-shares:event',
    chatEvent: 'session-shares:chat-event'
  },
  shell: {
    pickPrivateKey: 'shell:pick-private-key',
    pickSshCertificate: 'shell:pick-ssh-certificate',
    pickOpenSshConfig: 'shell:pick-openssh-config',
    pickXshellSessionFolder: 'shell:pick-xshell-session-folder',
    openExternal: 'shell:open-external'
  },
  window: {
    getState: 'window:get-state',
    minimize: 'window:minimize',
    maximize: 'window:maximize',
    restore: 'window:restore',
    close: 'window:close',
    stateChanged: 'window:state-changed',
    // 메뉴(Cmd+W)에서 렌더러로: 현재 활성 탭을 닫으라는 신호.
    closeActiveTab: 'window:close-active-tab',
    // 메뉴(탭 이동/다시 열기)에서 렌더러로: TabCommandPayload 를 실어 보낸다.
    tabCommand: 'window:tab-command'
  },
  system: {
    // OS 절전/잠금 복귀 알림. 자동 재연결이 죽은 소켓을 즉시 재검증하는 데 쓰인다.
    resume: 'system:resume'
  },
  tabs: {
    list: 'tabs:list'
  },
  updater: {
    getState: 'updater:get-state',
    check: 'updater:check',
    download: 'updater:download',
    installAndRestart: 'updater:install-and-restart',
    dismissAvailable: 'updater:dismiss-available',
    event: 'updater:event'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update'
  },
  ai: {
    testConnection: 'ai:test-connection',
    apiKeyStatus: 'ai:api-key-status',
    setApiKey: 'ai:set-api-key',
    clearApiKey: 'ai:clear-api-key',
    searchKeyStatus: 'ai:search-key-status',
    setSearchKey: 'ai:set-search-key',
    clearSearchKey: 'ai:clear-search-key',
    chat: 'ai:chat',
    cancelChat: 'ai:cancel-chat',
    // run_command 변경 명령 승인/거부(renderer→main).
    respondApproval: 'ai:respond-approval',
    // main → renderer 스트리밍 이벤트(delta/tool/approval-required/done/error). requestId 로 상관한다.
    chatEvent: 'ai:chat-event',
    // main → renderer: 현재 AI 요청에 고정된 터미널 스냅샷 범위를 읽어 달라는 client-side tool 요청.
    terminalOutputRequest: 'ai:terminal-output-request',
    // renderer → main: terminalOutputRequest 응답.
    terminalOutputResponse: 'ai:terminal-output-response',
    // Codex(ChatGPT 계정) 인증 — 로그인 URL 발급 / 상태 조회 / 로그아웃.
    codexLoginStart: 'ai:codex-login-start',
    codexAuthStatus: 'ai:codex-auth-status',
    codexLogout: 'ai:codex-logout',
    // Codex 요금제 사용량(rate limit) 조회.
    codexUsage: 'ai:codex-usage'
  },
  notifications: {
    commandFinished: 'notifications:command-finished'
  },
  portForwards: {
    list: 'port-forwards:list',
    create: 'port-forwards:create',
    update: 'port-forwards:update',
    remove: 'port-forwards:remove',
    start: 'port-forwards:start',
    stop: 'port-forwards:stop',
    event: 'port-forwards:event'
  },
  dnsOverrides: {
    list: 'dns-overrides:list',
    create: 'dns-overrides:create',
    update: 'dns-overrides:update',
    setStaticActive: 'dns-overrides:set-static-active',
    remove: 'dns-overrides:remove'
  },
  snippets: {
    list: 'snippets:list',
    create: 'snippets:create',
    update: 'snippets:update',
    remove: 'snippets:remove'
  },
  knownHosts: {
    list: 'known-hosts:list',
    probeHost: 'known-hosts:probe-host',
    trust: 'known-hosts:trust',
    replace: 'known-hosts:replace',
    remove: 'known-hosts:remove'
  },
  logs: {
    list: 'logs:list',
    clear: 'logs:clear',
    changed: 'logs:changed'
  },
  sessionReplays: {
    open: 'session-replays:open',
    get: 'session-replays:get'
  },
  keychain: {
    list: 'keychain:list',
    load: 'keychain:load',
    copyPassword: 'keychain:copy-password',
    remove: 'keychain:remove',
    update: 'keychain:update',
    cloneForHost: 'keychain:clone-for-host'
  },
  sshKeys: {
    generate: 'ssh-keys:generate',
    copyPublicKey: 'ssh-keys:copy-public-key',
    install: 'ssh-keys:install'
  },
  containers: {
    beginLifecycle: 'containers:begin-lifecycle',
    reportLifecycleError: 'containers:report-lifecycle-error',
    list: 'containers:list',
    inspect: 'containers:inspect',
    logs: 'containers:logs',
    startTunnel: 'containers:start-tunnel',
    stopTunnel: 'containers:stop-tunnel',
    start: 'containers:start',
    stop: 'containers:stop',
    restart: 'containers:restart',
    remove: 'containers:remove',
    stats: 'containers:stats',
    searchLogs: 'containers:search-logs',
    openShell: 'containers:open-shell',
    release: 'containers:release',
    connectionProgress: 'containers:connection-progress'
  },
  files: {
    getHomeDirectory: 'files:get-home-directory',
    getDownloadsDirectory: 'files:get-downloads-directory',
    listRoots: 'files:list-roots',
    getParentPath: 'files:get-parent-path',
    list: 'files:list',
    mkdir: 'files:mkdir',
    rename: 'files:rename',
    chmod: 'files:chmod',
    delete: 'files:delete',
    saveZmodemDownload: 'files:save-zmodem-download',
    reveal: 'files:reveal'
  },
  sftp: {
    connect: 'sftp:connect',
    disconnect: 'sftp:disconnect',
    list: 'sftp:list',
    mkdir: 'sftp:mkdir',
    rename: 'sftp:rename',
    chmod: 'sftp:chmod',
    chown: 'sftp:chown',
    listPrincipals: 'sftp:list-principals',
    delete: 'sftp:delete',
    readFile: 'sftp:read-file',
    writeFile: 'sftp:write-file',
    startTransfer: 'sftp:start-transfer',
    cancelTransfer: 'sftp:cancel-transfer',
    pauseTransfer: 'sftp:pause-transfer',
    resumeTransfer: 'sftp:resume-transfer',
    connectionProgress: 'sftp:connection-progress',
    transferEvent: 'sftp:transfer-event'
  }
} as const;
