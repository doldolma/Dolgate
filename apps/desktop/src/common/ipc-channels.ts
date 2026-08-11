export const ipcChannels = {
  auth: {
    getState: 'auth:get-state',
    bootstrap: 'auth:bootstrap',
    retryOnline: 'auth:retry-online',
    beginBrowserLogin: 'auth:begin-browser-login',
    reopenBrowserLogin: 'auth:reopen-browser-login',
    cancelBrowserLogin: 'auth:cancel-browser-login',
    logout: 'auth:logout',
    deleteAccount: 'auth:delete-account',
    changeAccountPassword: 'auth:change-account-password',
    addPasskey: 'auth:add-passkey',
    listPasskeys: 'auth:list-passkeys',
    deletePasskey: 'auth:delete-passkey',
    setupVault: 'auth:setup-vault',
    unlockVault: 'auth:unlock-vault',
    resetVault: 'auth:reset-vault',
    changeVaultPassphrase: 'auth:change-vault-passphrase',
    migrateVault: 'auth:migrate-vault',
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
    getSyncedWorkspaceSnapshot: 'bootstrap:get-synced-workspace-snapshot',
    workspaceChanged: 'bootstrap:workspace-changed'
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
    getProfileStatusById: 'aws:get-profile-status-by-id',
    login: 'aws:login',
    loginById: 'aws:login-by-id',
    listRegions: 'aws:list-regions',
    listEc2Instances: 'aws:list-ec2-instances',
    // Windows 초기 관리자 비밀번호. 개인키는 메인 프로세스 밖으로 나가지 않는다.
    getWindowsPassword: 'aws:get-windows-password',
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
  hostTransfer: {
    previewExport: 'host-transfer:preview-export',
    exportSelection: 'host-transfer:export-selection',
    pickImportFile: 'host-transfer:pick-import-file',
    probeImport: 'host-transfer:probe-import',
    commitImport: 'host-transfer:commit-import',
    discardImport: 'host-transfer:discard-import'
  },
  xshell: {
    probeDefault: 'xshell:probe-default',
    addFolderToSnapshot: 'xshell:add-folder-to-snapshot',
    importSelection: 'xshell:import-selection',
    discardSnapshot: 'xshell:discard-snapshot'
  },
  rdp: {
    connect: 'rdp:connect',
    disconnect: 'rdp:disconnect',
    input: 'rdp:input',
    trustCertificate: 'rdp:trust-certificate',
    resize: 'rdp:resize',
    clipboard: 'rdp:clipboard',
    syncClipboard: 'rdp:sync-clipboard',
    // 원격 화면이 키보드를 잡았는지. 메인이 자기 단축키를 비켜 주는 데 쓴다 — 렌더러 도달 전
    // 단계(before-input-event)와 메뉴 accelerator 는 메인만 끌 수 있다.
    keyboardCapture: 'rdp:keyboard-capture',
    pickShareFolder: 'rdp:pick-share-folder',
    // 배치도 UI 가 그릴 로컬 디스플레이 목록.
    listMonitors: 'rdp:list-monitors',
    // 이미 붙어 있는 세션의 접속 정보(크기·모니터 배치). 모니터별 창이 뒤늦게 물어본다.
    describeSession: 'rdp:describe-session',
    // 지금 화면 전체를 한 번 더 보내 달라. 세션 도중에 붙는 창이 검은 화면으로 남지 않게.
    refresh: 'rdp:refresh',
    // 원격 모니터를 물리 화면마다 펼치기 / 다시 한 창으로 접기.
    // 이 창이 이 세션의 픽셀을 원한다/그만 원한다. 프레임을 볼 창에만 보내기 위한 것.
    watch: 'rdp:watch',
    unwatch: 'rdp:unwatch',
    spreadMonitors: 'rdp:spread-monitors',
    collapseMonitors: 'rdp:collapse-monitors',
    event: 'rdp:event',
    // 픽셀 전용 채널. ssh.data 와 같은 이유로 store를 거치지 않고 캔버스로 직결한다.
    frame: 'rdp:frame',
    // 오디오도 픽셀과 같은 이유로 store 를 거치지 않는다.
    audio: 'rdp:audio'
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
    reinjectShellIntegration: 'ssh:reinject-shell-integration',
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
    openNew: 'window:open-new',
    openHost: 'window:open-host',
    consumeLaunchIntent: 'window:consume-launch-intent',
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
    codexUsage: 'ai:codex-usage',
    // Codex 사용 가능 모델 목록(model/list) — 설정의 모델 select 용.
    codexModels: 'ai:codex-models'
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
  tailnet: {
    list: 'tailnet:list',
    save: 'tailnet:save',
    remove: 'tailnet:remove',
    test: 'tailnet:test',
    forget: 'tailnet:forget',
    disconnect: 'tailnet:disconnect',
    cancel: 'tailnet:cancel',
    snapshot: 'tailnet:snapshot',
    // 연결 테스트 중 진행 상태를 렌더러로 밀어 준다. 브라우저 로그인이면 사용자가 인증하는
    // 동안 무엇을 기다리는지 보여줘야 해서 응답 하나로는 부족하다.
    status: 'tailnet:status'
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
    get: 'session-replays:get',
    storageUsage: 'session-replays:storage-usage'
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
