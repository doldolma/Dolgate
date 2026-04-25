import type {
  AppTheme,
  AuthState,
  HostRecord,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  DirectoryListing,
  SessionConnectionKind,
  SecretMetadataRecord,
  SshHostRecord,
  SyncStatus,
  TerminalTab,
} from "./models";

export interface HostSecretInput {
  password?: string;
  passphrase?: string;
  privateKeyPem?: string;
  certificateText?: string;
}

export interface ClientSessionEvent {
  type: "connected" | "closed" | "error";
  sessionId: string;
  message?: string | null;
}

export interface MobileAuthRedirectPayload {
  code: string;
  state?: string | null;
}

export interface MobileSettings {
  serverUrl: string;
  theme: AppTheme;
}

export interface MobileSessionRecord {
  id: string;
  sessionId: string;
  hostId: string;
  title: string;
  status: TerminalTab["status"];
  connectionKind?: SessionConnectionKind;
  connectionDetails?: string | null;
  hasReceivedOutput: boolean;
  isRestorable: boolean;
  lastViewportSnapshot: string;
  lastEventAt: string;
  lastConnectedAt?: string | null;
  lastDisconnectedAt?: string | null;
  errorMessage?: string | null;
}

export type MobileConnectionTabRef =
  | {
      kind: "terminal";
      id: string;
    }
  | {
      kind: "sftp";
      id: string;
    };

export type MobileSftpSessionStatus =
  | "connecting"
  | "connected"
  | "error"
  | "disconnecting"
  | "closed";

export interface MobileSftpSessionRecord {
  id: string;
  hostId: string;
  sourceSessionId: string;
  title: string;
  status: MobileSftpSessionStatus;
  currentPath: string;
  listing?: DirectoryListing | null;
  errorMessage?: string | null;
  lastEventAt: string;
  lastConnectedAt?: string | null;
  lastDisconnectedAt?: string | null;
}

export type MobileSftpTransferDirection = "download" | "upload" | "copy";
export type MobileSftpTransferStatus =
  | "pending"
  | "running"
  | "completed"
  | "error";

export interface MobileSftpTransferRecord {
  id: string;
  sftpSessionId: string;
  direction: MobileSftpTransferDirection;
  remotePath: string;
  localName: string;
  status: MobileSftpTransferStatus;
  bytesTransferred: number;
  totalBytes?: number | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientSshConnectInput {
  host: SshHostRecord;
  cols: number;
  rows: number;
  title?: string;
  secrets?: HostSecretInput;
}

export interface AwsSessionEnvSpec {
  env: Record<string, string>;
  unsetEnv: string[];
}

export interface ResolvedAwsConnectPayload {
  profileName: string;
  region: string;
  instanceId: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  unsetEnv?: string[];
}

export interface AwsSsmSessionStartRequest extends ResolvedAwsConnectPayload {
  hostId: string;
  label: string;
}

export type AwsSsmSessionClientMessage =
  | {
      type: "start";
      payload: AwsSsmSessionStartRequest;
    }
  | {
      type: "input";
      dataBase64: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "close";
    };

export type AwsSsmSessionServerMessage =
  | {
      type: "ready";
    }
  | {
      type: "output";
      dataBase64: string;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "exit";
      message?: string | null;
    };

export interface ClientApi {
  auth: {
    getState: () => Promise<AuthState>;
    beginBrowserLogin: () => Promise<void>;
    completeBrowserLogin: (
      payload: MobileAuthRedirectPayload,
    ) => Promise<AuthState>;
    refresh: () => Promise<AuthState>;
    logout: () => Promise<void>;
  };
  sync: {
    bootstrap: () => Promise<SyncStatus>;
    pushKnownHosts: (records: KnownHostRecord[]) => Promise<SyncStatus>;
    status: () => Promise<SyncStatus>;
  };
  hosts: {
    list: () => Promise<HostRecord[]>;
  };
  knownHosts: {
    list: () => Promise<KnownHostRecord[]>;
  };
  secrets: {
    list: () => Promise<SecretMetadataRecord[]>;
    load: (secretRef: string) => Promise<LoadedManagedSecretPayload | null>;
  };
  settings: {
    get: () => Promise<MobileSettings>;
    update: (input: Partial<MobileSettings>) => Promise<MobileSettings>;
  };
  sessions: {
    list: () => Promise<MobileSessionRecord[]>;
    connect: (input: ClientSshConnectInput) => Promise<{ sessionId: string }>;
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    disconnect: (sessionId: string) => Promise<void>;
    onEvent: (listener: (event: ClientSessionEvent) => void) => () => void;
    onData: (
      sessionId: string,
      listener: (chunk: Uint8Array) => void,
    ) => () => void;
  };
}
