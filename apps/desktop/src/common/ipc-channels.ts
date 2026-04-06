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
    remove: 'hosts:remove'
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
    respondKeyboardInteractive: 'ssh:respond-keyboard-interactive',
    event: 'ssh:core-event',
    data: 'ssh:stream-data'
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
    stateChanged: 'window:state-changed'
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
  knownHosts: {
    list: 'known-hosts:list',
    probeHost: 'known-hosts:probe-host',
    trust: 'known-hosts:trust',
    replace: 'known-hosts:replace',
    remove: 'known-hosts:remove'
  },
  logs: {
    list: 'logs:list',
    clear: 'logs:clear'
  },
  sessionReplays: {
    open: 'session-replays:open',
    get: 'session-replays:get'
  },
  keychain: {
    list: 'keychain:list',
    load: 'keychain:load',
    remove: 'keychain:remove',
    update: 'keychain:update',
    cloneForHost: 'keychain:clone-for-host'
  },
  containers: {
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
    delete: 'files:delete'
  },
  sftp: {
    connect: 'sftp:connect',
    disconnect: 'sftp:disconnect',
    list: 'sftp:list',
    mkdir: 'sftp:mkdir',
    rename: 'sftp:rename',
    chmod: 'sftp:chmod',
    delete: 'sftp:delete',
    startTransfer: 'sftp:start-transfer',
    cancelTransfer: 'sftp:cancel-transfer',
    connectionProgress: 'sftp:connection-progress',
    transferEvent: 'sftp:transfer-event'
  }
} as const;
