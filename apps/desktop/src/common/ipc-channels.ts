export const ipcChannels = {
  auth: {
    getState: 'auth:get-state',
    bootstrap: 'auth:bootstrap',
    beginBrowserLogin: 'auth:begin-browser-login',
    logout: 'auth:logout',
    event: 'auth:event'
  },
  sync: {
    bootstrap: 'sync:bootstrap',
    pushDirty: 'sync:push-dirty',
    status: 'sync:status',
    exportDecryptedSnapshot: 'sync:export-decrypted-snapshot'
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
    remove: 'groups:remove'
  },
  aws: {
    listProfiles: 'aws:list-profiles',
    getProfileStatus: 'aws:get-profile-status',
    login: 'aws:login',
    listRegions: 'aws:list-regions',
    listEc2Instances: 'aws:list-ec2-instances'
  },
  warpgate: {
    testConnection: 'warpgate:test-connection',
    getConnectionInfo: 'warpgate:get-connection-info',
    listSshTargets: 'warpgate:list-ssh-targets'
  },
  termius: {
    probeLocal: 'termius:probe-local',
    importSelection: 'termius:import-selection',
    discardSnapshot: 'termius:discard-snapshot'
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
    event: 'session-shares:event'
  },
  shell: {
    pickPrivateKey: 'shell:pick-private-key',
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
  keychain: {
    list: 'keychain:list',
    load: 'keychain:load',
    remove: 'keychain:remove',
    update: 'keychain:update',
    cloneForHost: 'keychain:clone-for-host'
  },
  files: {
    getHomeDirectory: 'files:get-home-directory',
    getDownloadsDirectory: 'files:get-downloads-directory',
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
    transferEvent: 'sftp:transfer-event'
  }
} as const;
