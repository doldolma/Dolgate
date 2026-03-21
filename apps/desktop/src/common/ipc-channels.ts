export const ipcChannels = {
  hosts: {
    list: 'hosts:list',
    create: 'hosts:create',
    update: 'hosts:update',
    remove: 'hosts:remove'
  },
  groups: {
    list: 'groups:list',
    create: 'groups:create'
  },
  ssh: {
    connect: 'ssh:connect',
    write: 'ssh:write',
    writeBinary: 'ssh:write-binary',
    resize: 'ssh:resize',
    disconnect: 'ssh:disconnect',
    event: 'ssh:core-event',
    data: 'ssh:stream-data'
  },
  shell: {
    pickPrivateKey: 'shell:pick-private-key',
    openExternal: 'shell:open-external'
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
    removeForHost: 'keychain:remove-for-host'
  },
  files: {
    getHomeDirectory: 'files:get-home-directory',
    list: 'files:list',
    mkdir: 'files:mkdir',
    rename: 'files:rename',
    delete: 'files:delete'
  },
  sftp: {
    connect: 'sftp:connect',
    disconnect: 'sftp:disconnect',
    list: 'sftp:list',
    mkdir: 'sftp:mkdir',
    rename: 'sftp:rename',
    delete: 'sftp:delete',
    startTransfer: 'sftp:start-transfer',
    cancelTransfer: 'sftp:cancel-transfer',
    transferEvent: 'sftp:transfer-event'
  }
} as const;
