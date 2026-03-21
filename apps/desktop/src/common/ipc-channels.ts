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
    pickPrivateKey: 'shell:pick-private-key'
  },
  tabs: {
    list: 'tabs:list'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update'
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
