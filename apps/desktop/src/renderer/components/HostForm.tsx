import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { MAX_HOST_STARTUP_COMMAND_LENGTH, describeRdpDrives, isAwsEc2HostRecord, isAwsEcsHostRecord, isRdpHostDraft, isRdpHostRecord, isVncHostDraft, isVncHostRecord, isSerialHostDraft, isSerialHostRecord, isSshHostDraft, isSshHostRecord, isWarpgateSshHostRecord } from '@shared';
import type { AwsProfileSummary, HostDraft, HostEnvVar, HostRecord, HostSecretInput, HostStartupCommand, RdpHostDraft, SecretMetadataRecord, SerialHostDraft, SerialPortSummary, SnippetRecord, SshAgentProbeResult, SshHostDraft, SshHostRecord, TerminalThemeId, VncHostDraft } from '@shared';
import { useHostFormController } from '../controllers/useHostFormController';
import { EnvironmentVariablesEditor } from './EnvironmentVariablesEditor';
import { loadSavedCredential } from '../services/desktop/settings';
import { pickRdpShareFolder } from '../services/desktop/rdp';
import { CredentialSelect } from './CredentialSelect';
import { terminalThemePresets } from '../lib/terminal-presets';
import { listAwsProfiles } from '../services/desktop/imports';
import { Button, IconButton, Input, SearchableSelect, SelectField, TagInputField, Textarea, ToggleSwitch } from '../ui';
import { FolderPlus, Trash2 } from '../ui/icons';
import type { SearchableSelectOption } from '../ui';
import { ArrowDown, ArrowUp, X } from '../ui/icons';
import { useTranslation } from 'react-i18next';
import { t } from "../i18n";
import { getAwsEc2HostSshMetadataStatusLabel } from '../../common/aws-diagnostics';

function agentStatusColor(
  status: SshAgentProbeResult['status'] | undefined,
): string {
  switch (status) {
    case 'ok':
      return 'var(--success-text)';
    case 'unreachable':
    case 'not-found':
      return 'var(--danger-text)';
    case 'empty':
      return 'var(--accent-strong)';
    default:
      return 'var(--text-muted)';
  }
}

function agentStatusText(probe: SshAgentProbeResult | null): string {
  if (!probe) {
    return t('hostForm.agent.checking');
  }
  switch (probe.status) {
    case 'ok':
      return `${t('hostForm.agent.detected')}${
        typeof probe.keyCount === 'number'
          ? t('hostForm.agent.keyCount', { count: probe.keyCount })
          : ''
      }`;
    case 'empty':
      return t('hostForm.agent.noKeys');
    case 'unreachable':
      return t('hostForm.agent.unreachable');
    case 'not-found':
      return t('hostForm.agent.notFound');
    default:
      return t('hostForm.agent.unknown');
  }
}

const defaultSshDraft: SshHostDraft = {
  kind: 'ssh',
  label: '',
  tags: [],
  hostname: '',
  username: '',
  port: 22,
  authType: 'password',
  secretRef: null,
  jumpHostId: null,
  startupCommand: null,
  agentForwarding: null,
  groupName: '',
  terminalThemeId: null
};

// Saved SSH hosts that can act as a jump host (bastion) for another host.
// Excludes the host being edited (no self-jump) and non-SSH kinds (jump targets
// must be a plain SSH host). The "None (direct)" option is added by the form.
// `description` carries the address so the picker can be searched by it too.
export function getJumpHostCandidates(
  hosts: HostRecord[],
  selfId: string | null,
): SearchableSelectOption[] {
  return hosts
    .filter((host): host is SshHostRecord => isSshHostRecord(host))
    .filter((host) => host.id !== selfId)
    .map((host) => ({
      value: host.id,
      label: host.label?.trim() || host.hostname,
      description: `${host.username ? `${host.username}@` : ''}${host.hostname}:${host.port}`,
    }));
}

// 드래프트의 ProxyJump 체인을 배열로 정규화(신규 jumpHostIds 우선, 레거시 jumpHostId 폴백).
// shared-core의 normalizeJumpHostIds와 같은 의미지만, @shared value를 렌더러에서 import하면
// vite dev의 export* 누락으로 화면이 비는 이슈가 있어 여기 인라인한다(타입 import만 안전).
function deriveJumpChain(draft: SshHostDraft): string[] {
  const ids =
    Array.isArray(draft.jumpHostIds) && draft.jumpHostIds.length > 0
      ? draft.jumpHostIds
      : draft.jumpHostId
        ? [draft.jumpHostId]
        : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

// 다단 ProxyJump 체인 편집기. 순서 = 첫 홉(클라이언트에서 직접 연결)…마지막 홉(타깃 바로 앞).
function JumpHostChainEditor({
  value,
  candidates,
  disabled = false,
  onChange,
}: {
  value: string[];
  candidates: SearchableSelectOption[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const { t: translate } = useTranslation();
  const optionsFor = (index: number) =>
    candidates.filter(
      (option) =>
        String(option.value) === value[index] || !value.includes(String(option.value)),
    );
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) {
      return;
    }
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const remaining = candidates.filter((option) => !value.includes(String(option.value)));
  const iconButtonClass =
    'inline-grid h-[1.9rem] w-[1.9rem] shrink-0 place-items-center rounded-[8px] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)] disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div className="grid gap-[0.4rem]">
      {value.map((id, index) => (
        <div key={`${id}-${index}`} className="flex items-center gap-[0.4rem]">
          <span className="inline-grid h-[1.6rem] w-[1.6rem] shrink-0 place-items-center rounded-[8px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] text-[0.72rem] font-semibold text-[var(--text-soft)]">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <SearchableSelect
              ariaLabel={`Jump host ${index + 1}`}
              placeholder={translate('hostForm.jump.selectPlaceholder')}
              searchPlaceholder={translate('hostForm.jump.searchPlaceholder')}
              value={id}
              options={optionsFor(index)}
              disabled={disabled}
              onChange={(next) => {
                if (!next) {
                  onChange(value.filter((_, i) => i !== index));
                  return;
                }
                const updated = [...value];
                updated[index] = next;
                onChange(updated);
              }}
            />
          </div>
          <button
            type="button"
            className={iconButtonClass}
            aria-label={translate('hostForm.jump.moveUp', { index: index + 1 })}
            disabled={disabled || index === 0}
            onClick={() => move(index, -1)}
          >
            <ArrowUp className="h-[0.95rem] w-[0.95rem]" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label={translate('hostForm.jump.moveDown', { index: index + 1 })}
            disabled={disabled || index === value.length - 1}
            onClick={() => move(index, 1)}
          >
            <ArrowDown className="h-[0.95rem] w-[0.95rem]" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label={translate('hostForm.jump.remove', { index: index + 1 })}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <X className="h-[1rem] w-[1rem]" />
          </button>
        </div>
      ))}
      {remaining.length > 0 ? (
        <SearchableSelect
          ariaLabel={translate('hostForm.jump.addAria')}
          placeholder={value.length === 0 ? 'None (direct)' : translate('hostForm.jump.addPlaceholder')}
          searchPlaceholder={translate('hostForm.jump.searchPlaceholder')}
          value=""
          options={remaining}
          disabled={disabled}
          onChange={(next) => {
            if (next) {
              onChange([...value, next]);
            }
          }}
        />
      ) : null}
    </div>
  );
}

const defaultSerialDraft: SerialHostDraft = {
  kind: 'serial',
  label: '',
  tags: [],
  transport: 'local',
  devicePath: '',
  host: '',
  port: 4001,
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none',
  transmitLineEnding: 'none',
  localEcho: false,
  localLineEditing: false,
  groupName: '',
  terminalThemeId: null,
};

const defaultRdpDraft: RdpHostDraft = {
  kind: 'rdp',
  label: '',
  tags: [],
  hostname: '',
  port: 3389,
  secretRef: null,
  drives: null,
  adminSession: null,
  useAllMonitors: null,
  // null 이 "켜짐"이다. 명시적으로 false 를 넣지 않는다 — 저장 계층이 false 만 기록한다.
  audioEnabled: null,
  microphoneEnabled: null,
  cameraEnabled: null,
  clipboardEnabled: null,
  colorDepth: null,
  tailnetId: null,
  groupName: '',
  terminalThemeId: null,
};

const defaultVncDraft: VncHostDraft = {
  kind: 'vnc',
  label: '',
  tags: [],
  hostname: '',
  // RFB 기본 포트. 디스플레이 번호 n 은 5900+n 으로 쓰는 관행이다.
  port: 5900,
  secretRef: null,
  // null 이 "공유(켜짐)"다. 저장 계층이 false 만 기록한다 — RDP 의 audioEnabled 와 같은 규칙.
  shared: null,
  viewOnly: null,
  tailnetId: null,
  sshTunnelHostId: null,
  groupName: '',
  terminalThemeId: null,
};

function createDraft(
  defaultGroupPath?: string | null,
  kind: 'ssh' | 'serial' | 'rdp' | 'vnc' = 'ssh',
): HostDraft {
  if (kind === 'vnc') {
    return {
      ...defaultVncDraft,
      groupName: defaultGroupPath ?? '',
    };
  }
  if (kind === 'serial') {
    return {
      ...defaultSerialDraft,
      groupName: defaultGroupPath ?? ''
    };
  }
  if (kind === 'rdp') {
    return {
      ...defaultRdpDraft,
      groupName: defaultGroupPath ?? ''
    };
  }
  return {
    ...defaultSshDraft,
    groupName: defaultGroupPath ?? ''
  };
}

function normalizeTagToken(value: string): string {
  return value.trim();
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const nextTags: string[] = [];

  for (const rawTag of tags) {
    const tag = normalizeTagToken(rawTag);
    if (!tag) {
      continue;
    }
    const normalized = tag.toLocaleLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    nextTags.push(tag);
  }

  return nextTags;
}

function appendPendingTag(tags: string[], pendingInput: string): string[] {
  return dedupeTags([...tags, pendingInput]);
}

function deriveDefaultHostLabel(draft: HostDraft): string {
  if (draft.kind === 'ssh') {
    return draft.hostname.trim();
  }
  if (draft.kind === 'serial') {
    if (draft.transport === 'local') {
      return draft.devicePath?.trim() || '';
    }
    const host = draft.host?.trim() ?? '';
    if (!host) {
      return '';
    }
    return draft.port ? `${host}:${draft.port}` : host;
  }
  if (draft.kind === 'rdp' || draft.kind === 'vnc') {
    return draft.hostname.trim();
  }
  if (draft.kind === 'aws-ec2') {
    return draft.awsInstanceName?.trim() || draft.awsInstanceId.trim();
  }
  if (draft.kind === 'aws-ecs') {
    return draft.awsEcsClusterName.trim();
  }
  return draft.label.trim();
}

export interface HostFormActionState {
  saveInFlight: boolean;
  saveStatusText: string | null;
}

export interface HostFormHandle {
  submitCreate: () => Promise<boolean>;
  /** 저장되지 않은 변경이 있는가. 편집 대상을 갈아탈 때 물어볼지 정하는 데 쓴다. */
  isDirty: () => boolean;
  /** 편집 폼을 명시적으로 저장(연결하지 않음). 호스트 필드 + 환경변수 모두 반영. */
  submit: () => Promise<boolean>;
  submitAndConnect: () => Promise<boolean>;
  /** 드로어 헤더의 편집 타이틀에서 이름을 바꿀 때 draft.label 을 갱신한다. */
  setLabel: (label: string) => void;
}

export interface HostFormProps {
  host: HostRecord | null;
  keychainEntries: SecretMetadataRecord[];
  groupOptions: Array<{ value: string | null; label: string }>;
  /** Saved SSH hosts selectable as a jump host (bastion). See getJumpHostCandidates. */
  jumpHostOptions?: SearchableSelectOption[];
  /**
   * 점프 후보 호스트별 tailnet 이름(설정돼 있는 것만).
   *
   * 접속은 **첫 홉**의 tailnet 을 탄다. 그것을 폼이 모르면 "점프에만 tailnet 을 걸어 둔" 구성이
   * 왜 되는지, 반대로 이 호스트에 걸어 둔 tailnet 이 왜 무시되는지 사용자가 알 수 없다.
   */
  jumpHostTailnetNames?: Record<string, string>;
  /** 설정에 등록된 tailnet. 이 호스트를 어느 tailnet 으로 보낼지 고르는 데 쓴다. */
  tailnetOptions?: Array<{ id: string; label: string }>;
  snippets?: SnippetRecord[];
  defaultGroupPath?: string | null;
  createKind?: 'ssh' | 'serial' | 'rdp' | 'vnc';
  desktopPlatform?: 'darwin' | 'win32' | 'linux' | 'unknown';
  hideTitle?: boolean;
  onSubmit: (draft: HostDraft, secrets?: HostSecretInput) => Promise<void>;
  onConnect?: (hostId: string) => Promise<void>;
  onEditExistingSecret?: (secretRef: string) => void;
  /** TAILNET 옆 Manage. 설정의 네트워크 섹션으로 보낸다. */
  onOpenTailnets?: () => void;
  onActionStateChange?: (state: HostFormActionState) => void;
  /** draft.label 이 바뀔 때마다 호출 — 드로어 헤더의 편집 가능한 타이틀과 동기화한다. */
  onLabelChange?: (label: string) => void;
}

type HostFormSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface HostFormSubmission {
  draft: HostDraft;
  secrets?: HostSecretInput;
}

interface ImportedShellCredentialFile {
  name: string;
  content: string;
}

interface AwsProfileSelectOption {
  value: string;
  profileId: string | null;
  profileName: string;
  isMissingCurrent?: boolean;
  isUnconfigured?: boolean;
}

function isHostDraftValid(draft: HostDraft): boolean {
  if (!(draft.label.trim() || deriveDefaultHostLabel(draft))) {
    return false;
  }

  if (draft.kind === 'aws-ec2') {
    return true;
  }

  if (draft.kind === 'aws-ecs') {
    return true;
  }

  if (draft.kind === 'ssh') {
    return Boolean(draft.hostname.trim()) && Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535;
  }
  if (draft.kind === 'serial') {
    if (draft.transport === 'local') {
      return Boolean((draft.devicePath ?? '').trim());
    }
    return Boolean((draft.host ?? '').trim()) && Number.isInteger(draft.port) && (draft.port ?? 0) >= 1 && (draft.port ?? 0) <= 65535;
  }

  if (draft.kind === 'rdp') {
    // 계정은 자격증명이 갖는다. 아래 isFormValid 의 hasRequiredRdpCredentials 가 본다.
    return (
      Boolean(draft.hostname.trim()) &&
      Number.isInteger(draft.port) &&
      draft.port >= 1 &&
      draft.port <= 65535
    );
  }

  if (draft.kind === 'vnc') {
    // 비밀번호는 서버가 요구할 때만 필요하다(None 으로 열어 둔 서버가 흔하다) — 필수로 두지 않는다.
    return (
      Boolean(draft.hostname.trim()) &&
      Number.isInteger(draft.port) &&
      draft.port >= 1 &&
      draft.port <= 65535
    );
  }

  if (draft.kind === 'warpgate-ssh') {
    return Boolean(draft.warpgateUsername.trim());
  }

  return true;
}

// @shared의 normalizeHostEnvVars를 인라인한다. vite dev가 shared-core의 export*로
// 새로 추가된 value export를 렌더러 module graph에서 비결정적으로 누락시켜 렌더러
// 로드를 깨는 이슈를 피하기 위함(설정 기본값 인라인과 동일한 이유).
const MAX_HOST_ENV_VARS = 100;
function normalizeHostEnvVars(
  value: HostEnvVar[] | null | undefined,
): HostEnvVar[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const result: HostEnvVar[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.key !== 'string' ||
      typeof entry.value !== 'string'
    ) {
      continue;
    }
    const key = entry.key.trim();
    if (!envNamePattern.test(key)) {
      continue;
    }
    result.push({ key, value: entry.value.replace(/[\r\n]+/g, '') });
    if (result.length >= MAX_HOST_ENV_VARS) {
      break;
    }
  }
  return result;
}

function buildHostFormSubmission(input: {
  draft: HostDraft;
  tags: string[];
  credentialMode: 'new' | 'existing';
  selectedSecretRef: string;
  /** RDP 새 자격증명의 계정. 호스트 레코드가 아니라 자격증명에 저장된다. */
  credentialUsername?: string;
  credentialDomain?: string;
  password: string;
  passphrase: string;
  privateKeyPem?: string;
  certificateText?: string;
  env?: HostEnvVar[];
}): HostFormSubmission {
  const nextTags = dedupeTags(input.tags);
  const nextLabel = input.draft.label.trim() || deriveDefaultHostLabel(input.draft);
  const normalizedDraft: HostDraft =
    input.draft.kind === 'ssh' ||
    input.draft.kind === 'aws-ec2' ||
    input.draft.kind === 'warpgate-ssh'
      ? {
          ...input.draft,
          startupCommand:
            input.draft.startupCommand?.type === 'command'
              ? input.draft.startupCommand.command.trim()
                ? input.draft.startupCommand
                : null
              : input.draft.startupCommand?.type === 'snippet'
                ? input.draft.startupCommand.snippetId.trim()
                  ? {
                      type: 'snippet',
                      snippetId: input.draft.startupCommand.snippetId.trim(),
                    }
                  : null
                : null,
        }
      : input.draft;
  // RDP·VNC 도 비밀번호를 시크릿 저장소에 둔다(SSH 와 같은 규칙). 아래 SSH 전용 경로는 키/인증서
  // 까지 다루므로 재사용하지 않고, 비밀번호만 취급하는 짧은 경로를 따로 둔다.
  //
  // **두 종류를 한 분기에서 처리한다.** RDP 만 보던 자리인데 VNC 를 추가할 때 여기를 잊어서
  // 비밀번호가 폼을 벗어나지 못했다 — 호스트는 저장되고 자격증명만 조용히 사라진다.
  if (isRdpHostDraft(normalizedDraft) || isVncHostDraft(normalizedDraft)) {
    const nextDraft: RdpHostDraft | VncHostDraft = {
      ...normalizedDraft,
      label: nextLabel,
      tags: nextTags,
      secretRef: input.credentialMode === 'existing' ? input.selectedSecretRef || null : null,
    };

    if (input.credentialMode !== 'new') {
      return { draft: nextDraft };
    }

    const username = input.credentialUsername?.trim() ?? '';
    const domain = input.credentialDomain?.trim() ?? '';
    return {
      draft: nextDraft,
      // 비밀번호가 없으면 자격증명을 만들지 않는다. 계정만 있는 자격증명은 의미가 없고,
      // hasSecretValue 도 그렇게 판단한다.
      secrets: input.password
        ? {
            // 종류를 그대로 실어 보낸다. 'rdp' 로 굳히면 VNC 자격증명이 RDP 목록에 섞인다.
            kind: normalizedDraft.kind,
            password: input.password,
            // VNC 폼에는 계정 칸이 없어서 지금은 비어 온다. VeNCrypt 의 Plain 계열을 지원하게
            // 되면 그때 폼만 채우면 이 경로는 그대로 쓴다.
            username: username || undefined,
            domain: domain || undefined,
          }
        : undefined,
    };
  }

  if (!isSshHostDraft(normalizedDraft)) {
    return {
      draft: {
        ...normalizedDraft,
        label: nextLabel,
        tags: nextTags
      }
    };
  }

  const nextDraft: SshHostDraft = {
    ...normalizedDraft,
    label: nextLabel,
    tags: nextTags,
    secretRef: input.credentialMode === 'existing' ? input.selectedSecretRef || null : null,
    privateKeyPath: null,
    certificatePath: null,
    // env는 자격증명이 아니라 호스트 속성 — 자격증명 모드와 무관하게 항상 드래프트(=호스트 레코드)에 저장.
    env: normalizeHostEnvVars(input.env)
  };

  if (input.credentialMode !== 'new') {
    return {
      draft: nextDraft
    };
  }

  const nextSecrets = {
    password: input.password || undefined,
    passphrase: input.passphrase || undefined,
    privateKeyPem: input.privateKeyPem || undefined,
    certificateText: input.certificateText || undefined
  };

  return {
    draft: nextDraft,
    secrets:
      nextSecrets.password ||
      nextSecrets.passphrase ||
      nextSecrets.privateKeyPem ||
      nextSecrets.certificateText
        ? nextSecrets
        : undefined
  };
}

function serializeHostFormSubmission(submission: HostFormSubmission): string {
  return JSON.stringify({
    draft: submission.draft,
    secrets: submission.secrets ?? null
  });
}

function buildHostHydrationKey(host: HostRecord): string {
  return `${host.id}:${host.updatedAt}`;
}

function renderTerminalThemeField(
  value: TerminalThemeId | null | undefined,
  onChange: (value: TerminalThemeId | null) => void
) {
  return (
    <label className="flex flex-col gap-[0.4rem] text-[var(--text)]">
      <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
        {t('hostForm.field.terminalTheme')}
      </span>
      <SelectField
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? (event.target.value as TerminalThemeId) : null)}
      >
        <option value="">{t('hostForm.option.globalTheme')}</option>
        {terminalThemePresets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.title}
          </option>
        ))}
      </SelectField>
    </label>
  );
}

interface FormSectionProps {
  title: string;
  // 섹션 부제목은 표시하지 않는다(길어지기만 하고 의미가 적음). prop은 호환을 위해 optional로 유지.
  description?: string;
  testId?: string;
  children: ReactNode;
}

function FormSection({ title, testId, children }: FormSectionProps) {
  return (
    <section
      data-testid={testId}
      className="grid gap-[0.9rem] rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)] px-[0.9rem] py-[0.8rem]"
    >
      <h3 className="text-[0.9rem] font-bold text-[var(--text)]">{title}</h3>
      <div className="grid gap-[0.9rem]">{children}</div>
    </section>
  );
}

export const HostForm = forwardRef<HostFormHandle, HostFormProps>(function HostForm({
  host,
  keychainEntries,
  groupOptions,
  jumpHostOptions = [],
  jumpHostTailnetNames = {},
  tailnetOptions = [],
  snippets = [],
  defaultGroupPath = null,
  createKind = 'ssh',
  desktopPlatform = 'unknown',
  hideTitle = false,
  onSubmit,
  onConnect,
  onEditExistingSecret,
  onOpenTailnets,
  onActionStateChange,
  onLabelChange
}: HostFormProps, ref) {
  const { t: translate } = useTranslation();
  const fieldClassName = 'flex flex-col gap-[0.4rem] text-[var(--text)]';
  const fieldLabelClassName =
    'text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]';
  const {
    listSerialPorts,
    pickPrivateKey: pickPrivateKeyFile,
    pickSshCertificate: pickSshCertificateFile,
    probeSshAgent,
  } = useHostFormController();
  const formRef = useRef<HTMLFormElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const lastHydratedHostIdRef = useRef<string | null>(null);
  const lastHydratedHostKeyRef = useRef<string | null>(null);
  const isTagInputComposingRef = useRef(false);
  const skipNextTagBlurCommitRef = useRef(false);
  const [draft, setDraft] = useState<HostDraft>(createDraft(defaultGroupPath, createKind));
  const [tagTokens, setTagTokens] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [envVars, setEnvVars] = useState<HostEnvVar[]>([]);
  const envLoadedSecretRef = useRef<string | null>(null);
  const loadedEnvSnapshotRef = useRef('');
  const [credentialMode, setCredentialMode] = useState<'new' | 'existing'>('new');
  // 새 자격증명의 계정. 비밀번호와 같이 드래프트가 아니라 폼 상태에 둔다 — 저장될 곳이 호스트
  // 레코드가 아니라 자격증명이기 때문이다.
  const [credentialUsername, setCredentialUsername] = useState('');
  const [credentialDomain, setCredentialDomain] = useState('');
  const [selectedSecretRef, setSelectedSecretRef] = useState('');
  const [privateKeyFile, setPrivateKeyFile] = useState<ImportedShellCredentialFile | null>(null);
  const [certificateFile, setCertificateFile] = useState<ImportedShellCredentialFile | null>(null);
  const [saveStatus, setSaveStatus] = useState<HostFormSaveStatus>('idle');
  const [lastSavedSubmissionKey, setLastSavedSubmissionKey] = useState<string | null>(null);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [awsProfiles, setAwsProfiles] = useState<AwsProfileSummary[]>([]);
  const [isLoadingAwsProfiles, setIsLoadingAwsProfiles] = useState(false);
  const [awsProfilesError, setAwsProfilesError] = useState<string | null>(null);
  const [serialPorts, setSerialPorts] = useState<SerialPortSummary[]>([]);
  const [isLoadingSerialPorts, setIsLoadingSerialPorts] = useState(false);
  const [serialPortsError, setSerialPortsError] = useState<string | null>(null);

  const isEditMode = Boolean(host);

  const sshDraft = isSshHostDraft(draft) ? draft : null;
  const selectedTailnetId = sshDraft?.tailnetId?.trim() ?? '';
  const missingTailnetId =
    selectedTailnetId && !tailnetOptions.some((option) => option.id === selectedTailnetId)
      ? selectedTailnetId
      : '';
  // SSH Agent 인증 선택 시 로컬 agent 상태를 조회해 설정 시점에 표시(설정 실수를 미리 잡음).
  const [agentProbe, setAgentProbe] = useState<SshAgentProbeResult | null>(null);
  const isAgentAuthDraft = sshDraft?.authType === 'agent';
  useEffect(() => {
    if (!isAgentAuthDraft) {
      setAgentProbe(null);
      return;
    }
    let cancelled = false;
    setAgentProbe(null);
    probeSshAgent()
      .then((result) => {
        if (!cancelled) {
          setAgentProbe(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgentProbe({ status: 'unknown' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAgentAuthDraft, probeSshAgent]);
  const serialDraft = isSerialHostDraft(draft) ? draft : null;
  const rdpDraft = isRdpHostDraft(draft) ? draft : null;
  const vncDraft = isVncHostDraft(draft) ? draft : null;
  // 원격에 보일 드라이브 이름. 코어로 나가는 값과 같은 함수로 만든다 — 규칙이 두 곳에 있으면
  // 화면에 보여준 이름과 원격에 뜨는 이름이 갈린다.
  const rdpDrives = describeRdpDrives(rdpDraft?.drives);
  // VNC 의 경로 두 개. 상호배타라서 서로의 잠금 조건이 된다.
  const vncTunnelHostId = vncDraft?.sshTunnelHostId?.trim() ?? '';
  const vncTailnetId = vncDraft?.tailnetId?.trim() ?? '';
  const vncTunnelMissing =
    vncTunnelHostId !== '' &&
    !jumpHostOptions.some((option) => option.value === vncTunnelHostId);
  const vncTunnelOptions: SearchableSelectOption[] = [
    // 끄는 것도 목록 안에 둔다 — 검색 목록에는 값을 비울 다른 방법이 없다.
    { value: '', label: translate('hostForm.vnc.tunnel.none') },
    ...jumpHostOptions,
    // 저장된 터널 호스트가 지워졌을 수 있다. 목록에서 빼면 "안 쓰는 것" 으로 보여 조용히 직접
    // 접속으로 바뀐다 — 그대로 남겨 두고 경고한다.
    ...(vncTunnelMissing
      ? [
          {
            value: vncTunnelHostId,
            label: translate('hostForm.vnc.tunnel.missingOption'),
          },
        ]
      : []),
  ];
  /**
   * 터널을 고르거나 끈다.
   *
   * 켤 때 주소가 비어 있으면 `127.0.0.1` 을 채운다 — 터널 뒤의 VNC 서버는 대개 경유 서버 자신이고,
   * 빈 칸으로 두면 required 에 걸려 저장이 막힌다. 이미 적어 둔 주소는 건드리지 않는다(경유 서버
   * 뒤의 다른 기기를 가리킬 수 있다).
   */
  const selectVncTunnelHost = (hostId: string | null) => {
    if (!vncDraft) {
      return;
    }
    setDraft({
      ...vncDraft,
      sshTunnelHostId: hostId,
      hostname:
        hostId && vncDraft.hostname.trim() === '' ? '127.0.0.1' : vncDraft.hostname,
    });
  };
  const jumpHostChain = sshDraft ? deriveJumpChain(sshDraft) : [];
  // 실제로 소켓을 여는 것은 첫 홉이다 — tailnet 도 그 홉의 것을 탄다.
  const entryHopId = jumpHostChain[0] ?? '';
  const entryHopTailnetName = entryHopId
    ? (jumpHostTailnetNames[entryHopId] ?? '')
    : '';
  const entryHopLabel =
    jumpHostOptions.find((option) => option.value === entryHopId)?.label ??
    entryHopId;
  const commitJumpHostChain = (ids: string[]) => {
    if (!sshDraft) {
      return;
    }
    setDraft({
      ...sshDraft,
      jumpHostIds: ids.length > 0 ? ids : null,
      // 레거시 단일 필드도 첫 홉으로 미러링(구버전 클라이언트 호환).
      jumpHostId: ids[0] ?? null,
    });
  };
  const isAwsEc2Draft = draft.kind === 'aws-ec2';
  const isAwsEcsDraft = draft.kind === 'aws-ecs';
  const isAwsDraft = isAwsEc2Draft || isAwsEcsDraft;
  const currentSubmission = useMemo(
    () =>
      buildHostFormSubmission({
        draft,
        tags: tagTokens,
        credentialMode,
        selectedSecretRef,
        credentialUsername,
        credentialDomain,
        password,
        passphrase,
        privateKeyPem: privateKeyFile?.content,
        certificateText: certificateFile?.content,
        env: envVars
      }),
    [
      certificateFile?.content,
      credentialMode,
      draft,
      envVars,
      passphrase,
      password,
      privateKeyFile?.content,
      selectedSecretRef,
      tagTokens,
    ]
  );
  const currentSubmissionKey = useMemo(() => serializeHostFormSubmission(currentSubmission), [currentSubmission]);
  const isEditDirty = isEditMode && currentSubmissionKey !== lastSavedSubmissionKey;
  const reusableEntries = useMemo(() => {
    if (!sshDraft) {
      return [];
    }
    return keychainEntries.filter((entry) => {
      // RDP 자격증명은 여기 나오지 않는다. 계정이 자격증명에 딸려 있어 SSH 로는 쓸 수 없다.
      // kind 가 없는 항목은 SSH 용이다 — 이 필드가 생기기 전에 만든 것들이다.
      if (entry.kind === 'rdp') {
        return false;
      }
      if (sshDraft.authType === 'password') {
        return entry.hasPassword;
      }
      if (sshDraft.authType === 'certificate') {
        return entry.hasManagedPrivateKey && entry.hasCertificate;
      }
      return entry.hasManagedPrivateKey;
    });
  }, [keychainEntries, sshDraft]);
  // RDP 는 비밀번호만 쓴다. SSH 용 reusableEntries 를 고치지 않고 따로 둔다 — SSH 결과에 영향이
  // 갈 여지를 아예 없앤다.
  const rdpReusableEntries = useMemo(
    () =>
      rdpDraft
        ? keychainEntries.filter((entry) => entry.kind === 'rdp' && entry.hasPassword)
        : [],
    [keychainEntries, rdpDraft],
  );
  // VNC 는 비밀번호 하나만 쓴다(계정도 키도 없다). SSH·RDP 목록에 섞으면 고를 수 없는 항목만
  // 늘어난다 — 8자만 유효한 비밀번호라 다른 프로토콜에 쓸 수도 없다.
  const vncReusableEntries = useMemo(
    () =>
      vncDraft
        ? keychainEntries.filter((entry) => entry.kind === 'vnc' && entry.hasPassword)
        : [],
    [keychainEntries, vncDraft],
  );
  /**
   * 이 호스트가 가리키는 자격증명이 목록에 없을 때 쓸 항목.
   *
   * kind 가 없는 옛 항목이거나 목록 갱신이 늦은 경우다. 그냥 빼 버리면 셀렉트가 "새 자격증명"으로
   * 돌아가 **저장한 것이 풀린 것처럼 보인다**(실제로 그렇게 보였다). 있는 그대로 보여준다.
   *
   * RDP·VNC 가 같은 함수를 쓴다 — 한쪽에만 두면 다른 쪽에서 같은 증상이 다시 난다.
   */
  const findSelectedMissingEntry = useCallback(
    (active: boolean, entries: SecretMetadataRecord[]) => {
      if (!active || credentialMode !== 'existing' || !selectedSecretRef) {
        return null;
      }
      if (entries.some((entry) => entry.secretRef === selectedSecretRef)) {
        return null;
      }
      return (
        keychainEntries.find((entry) => entry.secretRef === selectedSecretRef) ?? {
          secretRef: selectedSecretRef,
          label: selectedSecretRef,
        }
      );
    },
    [credentialMode, keychainEntries, selectedSecretRef],
  );
  // 계정을 적었는데 비밀번호가 없는 상태. 이대로 저장하면 자격증명이 만들어지지 않는다.
  const accountNeedsPassword =
    credentialMode === 'new' && credentialUsername.trim().length > 0 && !password;
  const rdpSelectedMissingEntry = useMemo(
    () => findSelectedMissingEntry(Boolean(rdpDraft), rdpReusableEntries),
    [findSelectedMissingEntry, rdpDraft, rdpReusableEntries],
  );
  const vncSelectedMissingEntry = useMemo(
    () => findSelectedMissingEntry(Boolean(vncDraft), vncReusableEntries),
    [findSelectedMissingEntry, vncDraft, vncReusableEntries],
  );
  const awsProfileOptions = useMemo<AwsProfileSelectOption[]>(() => {
    if (!isAwsDraft) {
      return [];
    }
    const options: AwsProfileSelectOption[] = awsProfiles.flatMap((profile) =>
      profile.id
        ? [{
            value: profile.id,
            profileId: profile.id,
            profileName: profile.name,
          }]
        : [],
    );
    const currentProfileName = draft.awsProfileName.trim();
    const currentProfileId = draft.awsProfileId ?? null;
    const hasCurrentOption = currentProfileId
      ? options.some((option) => option.profileId === currentProfileId)
      : false;
    if (!hasCurrentOption) {
      options.unshift(
        currentProfileId || currentProfileName
          ? {
              value: currentProfileId ?? `missing:${currentProfileName}`,
              profileId: currentProfileId,
              profileName: currentProfileName || 'Unknown',
              isMissingCurrent: true,
            }
          : {
              value: '',
              profileId: null,
              profileName: translate('hostForm.profile.select'),
              isUnconfigured: true,
            },
      );
    }
    return options;
  }, [awsProfiles, draft, isAwsDraft]);
  const selectedAwsProfileValue = useMemo(() => {
    if (!isAwsDraft) {
      return '';
    }
    const profileName = draft.awsProfileName.trim();
    return draft.awsProfileId ?? (profileName ? `missing:${profileName}` : '');
  }, [draft, isAwsDraft]);

  useEffect(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (!host) {
      setDraft(createDraft(defaultGroupPath, createKind));
      setPassword('');
      setPassphrase('');
      setSelectedSecretRef('');
      setCredentialMode('new');
      setPrivateKeyFile(null);
      setCertificateFile(null);
      setEnvVars([]);
      envLoadedSecretRef.current = null;
      loadedEnvSnapshotRef.current = '';
      setTagTokens([]);
      setTagInput('');
      setSaveStatus('idle');
      setSaveInFlight(false);
      setLastSavedSubmissionKey(null);
      lastHydratedHostIdRef.current = null;
      lastHydratedHostKeyRef.current = null;
      return;
    }

    const nextHydrationKey = buildHostHydrationKey(host);
    const isNewHost = lastHydratedHostIdRef.current !== host.id;
    const hasHostRevisionChanged = lastHydratedHostKeyRef.current !== nextHydrationKey;
    const shouldRehydrate = isNewHost || (hasHostRevisionChanged && !isEditDirty && !saveInFlight);
    if (!shouldRehydrate) {
      return;
    }

    let nextDraft: HostDraft;
    let nextCredentialMode: 'new' | 'existing';
    let nextSelectedSecretRef = '';
    // RDP 새 자격증명의 계정. 저장된 자격증명을 쓰는 호스트라면 비워 둔다(그 계정은 자격증명에 있다).
    let nextCredentialUsername = '';
    let nextCredentialDomain = '';
    let nextPassword = '';
    let nextPassphrase = '';
    let nextPrivateKeyFile: ImportedShellCredentialFile | null = null;
    let nextCertificateFile: ImportedShellCredentialFile | null = null;
    let nextEnvVars: HostEnvVar[] = [];

    if (isAwsEc2HostRecord(host)) {
      nextDraft = {
        kind: 'aws-ec2',
        label: host.label,
        tags: host.tags ?? [],
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
        awsProfileId: host.awsProfileId ?? null,
        awsProfileName: host.awsProfileName,
        awsRegion: host.awsRegion,
        awsInstanceId: host.awsInstanceId,
        awsAvailabilityZone: host.awsAvailabilityZone ?? null,
        awsInstanceName: host.awsInstanceName ?? null,
        awsPlatform: host.awsPlatform ?? null,
        awsPrivateIp: host.awsPrivateIp ?? null,
        awsState: host.awsState ?? null,
        awsSshUsername: host.awsSshUsername ?? null,
        awsSshPort: host.awsSshPort ?? 22,
        awsSshMetadataStatus: host.awsSshMetadataStatus ?? null,
        awsSshMetadataError: host.awsSshMetadataError ?? null,
        awsSsmServerProxyEnabled: host.awsSsmServerProxyEnabled === true,
        agentForwarding: host.agentForwarding === true ? true : null,
        startupCommand: host.startupCommand ?? null
      };
      nextCredentialMode = 'new';
    } else if (isAwsEcsHostRecord(host)) {
      nextDraft = {
        kind: 'aws-ecs',
        label: host.label,
        tags: host.tags ?? [],
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
        awsProfileId: host.awsProfileId ?? null,
        awsProfileName: host.awsProfileName,
        awsRegion: host.awsRegion,
        awsEcsClusterArn: host.awsEcsClusterArn,
        awsEcsClusterName: host.awsEcsClusterName
      };
      nextCredentialMode = 'new';
    } else if (isWarpgateSshHostRecord(host)) {
      nextDraft = {
        kind: 'warpgate-ssh',
        label: host.label,
        tags: host.tags ?? [],
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
        warpgateBaseUrl: host.warpgateBaseUrl,
        warpgateSshHost: host.warpgateSshHost,
        warpgateSshPort: host.warpgateSshPort,
        warpgateTargetId: host.warpgateTargetId,
        warpgateTargetName: host.warpgateTargetName,
        warpgateUsername: host.warpgateUsername,
        startupCommand: host.startupCommand ?? null
      };
      nextCredentialMode = 'new';
    } else if (isSerialHostRecord(host)) {
      nextDraft = {
        kind: 'serial',
        label: host.label,
        tags: host.tags ?? [],
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
        transport: host.transport,
        devicePath: host.devicePath ?? '',
        host: host.host ?? '',
        port: host.port ?? 4001,
        baudRate: host.baudRate,
        dataBits: host.dataBits,
        parity: host.parity,
        stopBits: host.stopBits,
        flowControl: host.flowControl,
        transmitLineEnding: host.transmitLineEnding,
        localEcho: host.localEcho,
        localLineEditing: host.localLineEditing,
      };
      nextCredentialMode = 'new';
    } else if (isRdpHostRecord(host)) {
      nextDraft = {
        kind: 'rdp',
        label: host.label,
        tags: host.tags ?? [],
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
        hostname: host.hostname,
        port: host.port,
        secretRef: host.secretRef,
        drives: host.drives ?? null,
        adminSession: host.adminSession ?? null,
        // 여기서 빠뜨리면 호스트를 편집해 저장할 때마다 그 설정이 조용히 초기값으로 돌아간다.
        // 전부 선택 필드라 컴파일러가 잡아주지 않는다.
        useAllMonitors: host.useAllMonitors ?? null,
        audioEnabled: host.audioEnabled ?? null,
        microphoneEnabled: host.microphoneEnabled ?? null,
        cameraEnabled: host.cameraEnabled ?? null,
        clipboardEnabled: host.clipboardEnabled ?? null,
        colorDepth: host.colorDepth ?? null,
        tailnetId: host.tailnetId ?? null,
      };
      nextSelectedSecretRef = host.secretRef ?? '';
      nextCredentialMode = host.secretRef ? 'existing' : 'new';
      // 계정은 자격증명에만 있다. 저장된 자격증명을 고른 상태면 그 계정이 쓰이고, 새 자격증명을
      // 만들 때만 아래 칸에 입력한다.
    } else if (isVncHostRecord(host)) {
      nextDraft = {
        kind: 'vnc',
        label: host.label,
        tags: host.tags ?? [],
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
        hostname: host.hostname,
        port: host.port,
        secretRef: host.secretRef,
        // 이것도 필드 나열 화이트리스트다. 빠뜨리면 편집해 저장할 때마다 그 설정이 조용히
        // 초기값으로 돌아간다(위 RDP 주석과 같은 이유).
        shared: host.shared ?? null,
        viewOnly: host.viewOnly ?? null,
        tailnetId: host.tailnetId ?? null,
        sshTunnelHostId: host.sshTunnelHostId ?? null,
      };
      nextSelectedSecretRef = host.secretRef ?? '';
      nextCredentialMode = host.secretRef ? 'existing' : 'new';
    } else {
      nextDraft = {
        kind: 'ssh',
        label: host.label,
        tags: host.tags ?? [],
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        authType: host.authType,
        secretRef: host.secretRef,
        jumpHostId: host.jumpHostId ?? null,
        jumpHostIds: host.jumpHostIds ?? (host.jumpHostId ? [host.jumpHostId] : null),
        // 이 seeding 도 필드를 나열하는 화이트리스트다. 빠뜨리면 저장은 되는데 폼이 되읽지
        // 못해 "사용하지 않음"으로 보이고, 그 상태에서 한 번 더 저장하면 실제로 null 이 된다.
        tailnetId: host.tailnetId ?? null,
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
        startupCommand: host.startupCommand ?? null,
        useMosh: host.useMosh ?? null,
        agentForwarding: host.agentForwarding ?? null,
        env: normalizeHostEnvVars(host.env)
      };
      nextSelectedSecretRef = host.secretRef ?? '';
      nextCredentialMode = host.secretRef ? 'existing' : 'new';
      nextEnvVars = normalizeHostEnvVars(host.env);
    }

    const nextTagTokens = dedupeTags(host.tags ?? []);
    const nextSubmissionKey = serializeHostFormSubmission(
      buildHostFormSubmission({
        draft: nextDraft,
        tags: nextTagTokens,
        credentialMode: nextCredentialMode,
        selectedSecretRef: nextSelectedSecretRef,
        password: nextPassword,
        passphrase: nextPassphrase
      })
    );

    setDraft(nextDraft);
    setPassword(nextPassword);
    setPassphrase(nextPassphrase);
    setSelectedSecretRef(nextSelectedSecretRef);
    setCredentialMode(nextCredentialMode);
    setCredentialUsername(nextCredentialUsername);
    setCredentialDomain(nextCredentialDomain);
    setPrivateKeyFile(nextPrivateKeyFile);
    setCertificateFile(nextCertificateFile);
    setEnvVars(nextEnvVars);
    envLoadedSecretRef.current = null;
    loadedEnvSnapshotRef.current = JSON.stringify(nextEnvVars);
    setTagTokens(nextTagTokens);
    setTagInput('');
    setSaveStatus('idle');
    setSaveInFlight(false);
    setLastSavedSubmissionKey(nextSubmissionKey);
    lastHydratedHostIdRef.current = host.id;
    lastHydratedHostKeyRef.current = nextHydrationKey;
  }, [createKind, defaultGroupPath, host, isEditDirty, saveInFlight]);

  useEffect(() => {
    if (!sshDraft) {
      return;
    }

    if (credentialMode === 'existing' && selectedSecretRef && !reusableEntries.some((entry) => entry.secretRef === selectedSecretRef)) {
      setSelectedSecretRef('');
      setCredentialMode('new');
    }
  }, [credentialMode, reusableEntries, selectedSecretRef, sshDraft]);


  const refreshSerialPorts = useCallback(async () => {
    setIsLoadingSerialPorts(true);
    setSerialPortsError(null);
    try {
      const nextPorts = await listSerialPorts();
      setSerialPorts(nextPorts);
    } catch (error) {
      setSerialPorts([]);
      setSerialPortsError(error instanceof Error ? error.message : translate('hostForm.error.serialPortsFailed'));
    } finally {
      setIsLoadingSerialPorts(false);
    }
  }, [listSerialPorts]);

  useEffect(() => {
    if (!serialDraft || serialDraft.transport !== 'local') {
      setSerialPorts([]);
      setSerialPortsError(null);
      setIsLoadingSerialPorts(false);
      return;
    }
    void refreshSerialPorts();
  }, [refreshSerialPorts, serialDraft?.transport, serialDraft]);

  useEffect(() => {
    if (!isAwsDraft) {
      setAwsProfiles([]);
      setAwsProfilesError(null);
      setIsLoadingAwsProfiles(false);
      return;
    }

    let canceled = false;
    setIsLoadingAwsProfiles(true);
    setAwsProfilesError(null);
    void listAwsProfiles()
      .then((profiles) => {
        if (canceled) {
          return;
        }
        setAwsProfiles(profiles);
      })
      .catch((error) => {
        if (canceled) {
          return;
        }
        setAwsProfiles([]);
        setAwsProfilesError(error instanceof Error ? error.message : translate('hostForm.error.awsProfilesFailed'));
      })
      .finally(() => {
        if (canceled) {
          return;
        }
        setIsLoadingAwsProfiles(false);
      });

    return () => {
      canceled = true;
    };
  }, [isAwsDraft]);

  useEffect(() => {
    if (!isEditMode || saveInFlight) {
      return;
    }
    if (isEditDirty && saveStatus !== 'idle') {
      setSaveStatus('idle');
    }
  }, [isEditDirty, isEditMode, saveInFlight, saveStatus]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  async function pickPrivateKey(): Promise<void> {
    if (!sshDraft) {
      return;
    }
    const selected = await pickPrivateKeyFile();
    if (!selected) {
      return;
    }
    setPrivateKeyFile({ name: selected.name, content: selected.content });
  }

  async function pickCertificate(): Promise<void> {
    if (!sshDraft) {
      return;
    }
    const selected = await pickSshCertificateFile();
    if (!selected) {
      return;
    }
    setCertificateFile({ name: selected.name, content: selected.content });
  }

  function updateDraftTags(nextTags: string[]) {
    setTagTokens(nextTags);
    setDraft((current) => ({
      ...current,
      tags: nextTags
    }));
  }

  function handleAwsProfileChange(nextValue: string) {
    const selectedProfile = awsProfileOptions.find((option) => option.value === nextValue);
    if (!selectedProfile) {
      return;
    }
    setDraft((current) => {
      if (current.kind === 'aws-ec2' || current.kind === 'aws-ecs') {
        return {
          ...current,
          awsProfileId: selectedProfile.profileId,
          awsProfileName: selectedProfile.profileName,
        };
      }
      return current;
    });
  }

  function handleSshHostnameChange(nextHostname: string) {
    setDraft((current) => {
      if (!isSshHostDraft(current)) {
        return current;
      }
      const previousAutoLabel = deriveDefaultHostLabel(current);
      const shouldSyncLabel =
        !host &&
        (current.label.trim() === '' || current.label.trim() === previousAutoLabel);
      const nextDraft: HostDraft = {
        ...current,
        hostname: nextHostname
      };
      return shouldSyncLabel
        ? {
            ...nextDraft,
            label: deriveDefaultHostLabel(nextDraft)
          }
        : nextDraft;
    });
  }

  function handleVncFieldChange<K extends keyof VncHostDraft>(key: K, value: VncHostDraft[K]) {
    setDraft((current) => {
      if (!isVncHostDraft(current)) {
        return current;
      }
      const previousAutoLabel = deriveDefaultHostLabel(current);
      // 라벨을 손대지 않은 동안에는 호스트명을 따라가게 둔다(다른 종류와 같은 동작).
      const shouldSyncLabel =
        !host &&
        (current.label.trim() === '' || current.label.trim() === previousAutoLabel);
      const nextDraft: VncHostDraft = {
        ...current,
        [key]: value,
      };
      return shouldSyncLabel
        ? { ...nextDraft, label: deriveDefaultHostLabel(nextDraft) }
        : nextDraft;
    });
  }

  function handleRdpFieldChange<K extends keyof RdpHostDraft>(key: K, value: RdpHostDraft[K]) {
    setDraft((current) => {
      if (!isRdpHostDraft(current)) {
        return current;
      }
      const previousAutoLabel = deriveDefaultHostLabel(current);
      // 라벨을 손대지 않은 동안에는 호스트명을 따라가게 둔다(다른 종류와 같은 동작).
      const shouldSyncLabel =
        !host &&
        (current.label.trim() === '' || current.label.trim() === previousAutoLabel);
      const nextDraft: RdpHostDraft = {
        ...current,
        [key]: value
      };
      return shouldSyncLabel
        ? { ...nextDraft, label: deriveDefaultHostLabel(nextDraft) }
        : nextDraft;
    });
  }

  function handleSerialFieldChange<K extends keyof SerialHostDraft>(key: K, value: SerialHostDraft[K]) {
    setDraft((current) => {
      if (!isSerialHostDraft(current)) {
        return current;
      }
      const previousAutoLabel = deriveDefaultHostLabel(current);
      const shouldSyncLabel =
        !host &&
        (current.label.trim() === '' || current.label.trim() === previousAutoLabel);
      const nextDraft: SerialHostDraft = {
        ...current,
        [key]: value
      };
      return shouldSyncLabel
        ? {
            ...nextDraft,
            label: deriveDefaultHostLabel(nextDraft)
          }
        : nextDraft;
    });
  }

  function commitPendingTag(options?: { suppressNextBlur?: boolean }) {
    const nextTags = appendPendingTag(tagTokens, tagInput);
    if (options?.suppressNextBlur) {
      skipNextTagBlurCommitRef.current = true;
    }
    if (nextTags.length === tagTokens.length) {
      setTagInput('');
      return nextTags;
    }
    updateDraftTags(nextTags);
    setTagInput('');
    return nextTags;
  }

  function removeTag(tagToRemove: string) {
    const normalized = tagToRemove.toLocaleLowerCase();
    updateDraftTags(tagTokens.filter((tag) => tag.toLocaleLowerCase() !== normalized));
  }

  const isFormValid = useCallback(
    (nextDraft: HostDraft) => {
      const hasRequiredSshCredentials = (() => {
        if (!isSshHostDraft(nextDraft)) {
          return true;
        }
        if (credentialMode === 'existing') {
          return Boolean(selectedSecretRef.trim());
        }
        if (nextDraft.authType === 'privateKey') {
          return Boolean(privateKeyFile?.content);
        }
        if (nextDraft.authType === 'certificate') {
          return Boolean(
            privateKeyFile?.content &&
            certificateFile?.content
          );
        }
        return true;
      })();
      // RDP 자격증명이 없어도 저장은 막지 않는다. SSH 도 비밀번호 없이 저장되고, 막아 두면
      // 버튼을 눌러도 아무 일이 없는데 이유를 알 수 없다(실제로 그렇게 막혔다).
      const browserValidity = formRef.current?.checkValidity();
      if (typeof browserValidity === 'boolean') {
        return browserValidity && isHostDraftValid(nextDraft) && hasRequiredSshCredentials;
      }
      return isHostDraftValid(nextDraft) && hasRequiredSshCredentials;
    },
    [certificateFile?.content, credentialMode, privateKeyFile?.content, selectedSecretRef]
  );

  const persistChanges = useCallback(
    async (options: { commitPendingTag: boolean }) => {
      if (!isEditMode || !host) {
        return false;
      }

      const nextTagTokens = options.commitPendingTag ? appendPendingTag(tagTokens, tagInput) : tagTokens;
      const nextDraft: HostDraft = {
        ...draft,
        tags: nextTagTokens
      };

      if (!isFormValid(nextDraft)) {
        // **왜 막혔는지 브라우저가 말해 주게 한다.** 생성 경로(reportCurrentValidity)는 이걸
        // 부르는데 저장 경로는 부르지 않아서, 필수 칸이 비면 저장 버튼을 눌러도 아무 일도
        // 일어나지 않고 이유도 보이지 않았다.
        formRef.current?.reportValidity();
        return false;
      }

      const submission = buildHostFormSubmission({
        draft: nextDraft,
        tags: nextTagTokens,
        credentialMode,
        selectedSecretRef,
        credentialUsername,
        credentialDomain,
        password,
        passphrase,
        privateKeyPem: privateKeyFile?.content,
        certificateText: certificateFile?.content,
        env: envVars
      });
      const submissionKey = serializeHostFormSubmission(submission);
      if (submissionKey === lastSavedSubmissionKey) {
        if (options.commitPendingTag && nextTagTokens !== tagTokens) {
          setTagTokens(nextTagTokens);
          setTagInput('');
          setDraft(nextDraft);
        }
        return true;
      }

      if (options.commitPendingTag && nextTagTokens !== tagTokens) {
        setTagTokens(nextTagTokens);
        setTagInput('');
        setDraft(nextDraft);
      }

      setSaveInFlight(true);
      setSaveStatus('saving');
      try {
        await onSubmit(submission.draft, submission.secrets);
        setLastSavedSubmissionKey(submissionKey);
        setSaveStatus('saved');
        return true;
      } catch (error) {
        setSaveStatus('error');
        throw error;
      } finally {
        setSaveInFlight(false);
      }
    },
    // submitCreate 와 같은 규칙이다: buildHostFormSubmission 이 읽는 값이 전부 들어 있어야 한다.
    // 계정·도메인이 빠져 있어서, 비밀번호를 먼저 넣고 계정을 나중에 적으면 계정만 빈 값으로
    // 저장됐다(RDP 편집에서도 같은 자리다).
    [
      credentialDomain,
      credentialMode,
      credentialUsername,
      draft,
      envVars,
      host,
      isEditMode,
      isFormValid,
      lastSavedSubmissionKey,
      onSubmit,
      passphrase,
      password,
      certificateFile?.content,
      privateKeyFile?.content,
      selectedSecretRef,
      tagInput,
      tagTokens
    ]
  );

  // 호스트 필드 자동저장 제거 — submit()로 명시적으로 저장(하단 "저장" 버튼)할 때만 반영한다.

  const saveStatusText =
    saveStatus === 'saving'
      ? translate('hostForm.save.saving')
      : saveStatus === 'saved'
        ? translate('hostForm.save.saved')
        : saveStatus === 'error'
          ? translate('hostForm.save.error')
          : null;
  /**
   * tailnet 선택 칸. SSH·RDP 가 같은 필드를 쓰므로 한 곳에서 그린다.
   *
   * 등록된 tailnet 이 없어도 칸은 보여 준다 — 숨기면 이 기능이 있다는 것 자체를 알 수 없고,
   * 기기마다 따로 등록하는 구조라 "다른 PC 에서는 없다"로 보인다.
   */
  const renderTailnetField = (
    currentTailnetId: string | null | undefined,
    onChange: (tailnetId: string | null) => void,
    /**
     * 이 호스트가 이미 다른 경로로 가도록 정해져 있으면 그 이유. 넘기면 칸을 잠근다.
     *
     * VNC 의 SSH 터널이 이 자리를 쓴다 — 둘 다 정하면 접속 경로가 tailnet 만 보고 끝나서 터널이
     * 조용히 무시된다(ipc/vnc.ts 의 openForward).
     */
    lockedReason?: string | null,
  ) => {
    const selected = currentTailnetId?.trim() ?? '';
    // 저장된 tailnet 이 이 기기에 없을 수 있다(다른 기기에서 등록). 지워진 것처럼 보이지 않게
    // 항목을 만들어 그대로 보여 주고 경고한다.
    const missing =
      selected && !tailnetOptions.some((option) => option.id === selected) ? selected : '';
    return (
      <div className={fieldClassName}>
        <div className="flex items-center justify-between gap-3">
          <span className={fieldLabelClassName}>{translate('hostForm.field.tailnet')}</span>
          {/* 자격증명 쪽과 달리 목록이 비어도 보여 준다 — 등록된 tailnet 이 없을 때가
              오히려 여기로 갈 이유가 가장 큰 순간이다. */}
          {onOpenTailnets ? (
            <button
              type="button"
              className="border-0 bg-transparent p-0 text-[0.9rem] font-semibold text-[var(--accent-strong)]"
              onClick={onOpenTailnets}
            >
              {translate('hostForm.action.manage')}
            </button>
          ) : null}
        </div>
        <SelectField
          value={selected}
          disabled={Boolean(lockedReason) || (tailnetOptions.length === 0 && !missing)}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{translate('hostForm.tailnet.none')}</option>
          {missing ? (
            <option value={missing}>{translate('hostForm.tailnet.missingOption')}</option>
          ) : null}
          {tailnetOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </SelectField>
        {/* 고를 것이 있으면 설명을 붙이지 않는다. 비어 있을 때만 안내가 필요하다 —
            tailnet 은 기기마다 따로 등록해야 해서 "다른 PC 에는 있는데" 로 헷갈린다. */}
        {lockedReason ? (
          <span className="text-[0.82rem] text-[var(--text-soft)]">{lockedReason}</span>
        ) : missing ? (
          <span className="text-[0.82rem] text-[var(--danger)]">
            {translate('hostForm.tailnet.missing')}
          </span>
        ) : tailnetOptions.length === 0 ? (
          <span className="text-[0.82rem] text-[var(--text-soft)]">
            {translate('hostForm.tailnet.empty')}
          </span>
        ) : null}
      </div>
    );
  };

  const metadataFields = (
    <>
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>{translate('hostForm.field.group')}</span>
        <SelectField value={draft.groupName ?? ''} onChange={(event) => setDraft({ ...draft, groupName: event.target.value || '' })}>
          {groupOptions.map((option) => (
            <option key={option.value ?? 'ungrouped'} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </label>
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>{translate('hostForm.field.tags')}</span>
        <TagInputField
          id="host-tag-input"
          aria-label={translate('hostForm.field.tags')}
          tags={tagTokens}
          value={tagInput}
          onRemoveTag={removeTag}
          onChange={(event) => {
            if (skipNextTagBlurCommitRef.current && event.target.value.trim()) {
              skipNextTagBlurCommitRef.current = false;
            }
            setTagInput(event.target.value);
          }}
          onCompositionStart={() => {
            isTagInputComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isTagInputComposingRef.current = false;
          }}
          onBlur={() => {
            if (skipNextTagBlurCommitRef.current) {
              skipNextTagBlurCommitRef.current = false;
              return;
            }
            if (tagInput.trim()) {
              commitPendingTag();
            }
          }}
          onKeyDown={(event) => {
            if (isTagInputComposingRef.current || event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commitPendingTag({ suppressNextBlur: true });
              return;
            }
            if (event.key === 'Backspace' && tagInput.length === 0 && tagTokens.length > 0) {
              event.preventDefault();
              updateDraftTags(tagTokens.slice(0, -1));
            }
          }}
          placeholder={tagTokens.length === 0 ? 'Type a tag and press Enter' : 'Add tag'}
        />
      </label>
    </>
  );

  const supportsStartupCommand =
    draft.kind === 'ssh' || draft.kind === 'aws-ec2' || draft.kind === 'warpgate-ssh';
  const startupCommand = supportsStartupCommand ? draft.startupCommand ?? null : null;
  const startupMode = startupCommand?.type ?? 'none';
  const startupSnippetOptions = snippets.map((snippet) => ({
    value: snippet.id,
    label: snippet.label,
    description: snippet.keyword ? `${snippet.keyword} · ${snippet.command}` : snippet.command,
    searchText: [snippet.label, snippet.keyword ?? '', snippet.command].join(' '),
  }));
  const selectedStartupSnippet =
    startupCommand?.type === 'snippet'
      ? snippets.find((snippet) => snippet.id === startupCommand.snippetId) ?? null
      : null;

  function updateStartupCommand(next: HostStartupCommand | null): void {
    setDraft((current) => {
      if (
        current.kind !== 'ssh' &&
        current.kind !== 'aws-ec2' &&
        current.kind !== 'warpgate-ssh'
      ) {
        return current;
      }
      return { ...current, startupCommand: next };
    });
  }

  const startupCommandField = supportsStartupCommand ? (
    <div className="flex flex-col gap-[0.55rem] text-[var(--text)]">
      <span className={fieldLabelClassName}>{translate('hostForm.field.startupCommand')}</span>
      <div className="grid grid-cols-3 gap-1 rounded-[8px] border border-[var(--border)] bg-[var(--app-bg)] p-1">
        {(['none', 'command', 'snippet'] as const).map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant="ghost"
            active={startupMode === mode}
            className="rounded-[5px]"
            onClick={() =>
              updateStartupCommand(
                mode === 'none'
                  ? null
                  : mode === 'command'
                    ? { type: 'command', command: '' }
                    : { type: 'snippet', snippetId: '' },
              )
            }
          >
            {mode === 'none'
              ? translate('hostForm.option.none')
              : mode === 'command'
                ? translate('hostForm.option.startupCommandMode')
                : translate('hostForm.option.startupSnippet')}
          </Button>
        ))}
      </div>
      {startupCommand?.type === 'command' ? (
        <div className="flex flex-col gap-[0.4rem]">
          <Textarea
            aria-label={translate('hostForm.field.startupCommand')}
            value={startupCommand.command}
            maxLength={MAX_HOST_STARTUP_COMMAND_LENGTH}
            rows={4}
            className="font-mono"
            placeholder="cd /srv/app && clear"
            onChange={(event) =>
              updateStartupCommand({ type: 'command', command: event.target.value })
            }
          />
          <span className="text-[0.76rem] text-[var(--text-soft)]">
            {translate('hostForm.startup.description')}
          </span>
        </div>
      ) : null}
      {startupCommand?.type === 'snippet' ? (
        <div className="flex flex-col gap-[0.4rem]">
          <SearchableSelect
            ariaLabel="Startup snippet"
            placeholder={translate('hostForm.startup.selectPlaceholder')}
            searchPlaceholder={translate('hostForm.startup.searchPlaceholder')}
            emptyText={translate('hostForm.startup.emptyText')}
            value={startupCommand.snippetId}
            options={startupSnippetOptions}
            onChange={(snippetId) =>
              updateStartupCommand({ type: 'snippet', snippetId })
            }
          />
          {selectedStartupSnippet ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-[var(--border)] bg-[var(--app-bg)] px-3 py-2 font-mono text-[0.76rem] text-[var(--text-soft)]">
              {selectedStartupSnippet.command}
            </pre>
          ) : startupCommand.snippetId ? (
            <span className="text-[0.82rem] text-[var(--danger-text)]">
              {translate('hostForm.startup.missing')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;

  const reportCurrentValidity = useCallback(() => {
    const valid = isFormValid(draft);
    if (!valid) {
      formRef.current?.reportValidity();
    }
    return valid;
  }, [draft, isFormValid]);

  const submitCreate = useCallback(async () => {
    if (isEditMode) {
      return false;
    }
    if (!reportCurrentValidity()) {
      return false;
    }

    const nextTags = appendPendingTag(tagTokens, tagInput);
    // **저장(편집)과 같은 함수를 쓴다.**
    //
    // 예전에는 여기서 SSH 만 자격증명을 다루고 나머지 종류는 draft 만 보냈다. 그래서 New Host 로
    // RDP·VNC 를 만들면서 비밀번호를 넣거나 기존 자격증명을 골라도 **아무것도 저장되지 않았다** —
    // 편집 화면에 들어가면 선택이 비어 있었다. 종류별 처리를 한 곳(buildHostFormSubmission)에만
    // 두면 생성과 편집이 갈릴 수 없다.
    const submission = buildHostFormSubmission({
      draft,
      tags: nextTags,
      credentialMode,
      selectedSecretRef,
      credentialUsername,
      credentialDomain,
      password,
      passphrase,
      privateKeyPem: privateKeyFile?.content,
      certificateText: certificateFile?.content,
      env: envVars,
    });
    await onSubmit(submission.draft, submission.secrets);
    return true;
    // **buildHostFormSubmission 이 읽는 값이 전부 들어 있어야 한다.** 하나라도 빠지면 그 값은
    // 마지막으로 콜백이 다시 만들어진 시점의 것으로 굳는다 — 계정을 비밀번호보다 나중에 입력하면
    // 계정만 조용히 빈 값으로 저장됐다(그렇게 새고 있었다).
  }, [
    credentialDomain,
    credentialMode,
    credentialUsername,
    draft,
    envVars,
    isEditMode,
    onSubmit,
    passphrase,
    password,
    certificateFile?.content,
    privateKeyFile?.content,
    reportCurrentValidity,
    selectedSecretRef,
    tagInput,
    tagTokens
  ]);

  const submitAndConnect = useCallback(async () => {
    if (!isEditMode || !host || !onConnect) {
      return false;
    }
    if (!reportCurrentValidity()) {
      return false;
    }

    const didSave = await persistChanges({ commitPendingTag: true }).catch(() => false);
    if (!didSave) {
      return false;
    }

    await onConnect(host.id);
    return true;
  }, [host, isEditMode, onConnect, persistChanges, reportCurrentValidity]);

  /**
   * 저장되지 않은 변경이 있는가.
   *
   * 저장 경로가 no-op 판정에 쓰는 스냅샷 비교를 그대로 쓴다([[persistChanges]]) — 판정 기준이
   * 갈라지면 "변경 없음" 이라고 넘어간 뒤 저장 때는 변경으로 잡히는(또는 그 반대) 일이 생긴다.
   *
   * 생성 모드에서는 비교 기준이 없다. 한 글자라도 입력했으면 버릴 것이 있다고 본다.
   */
  const isDirty = useCallback(() => {
    const submission = buildHostFormSubmission({
      draft,
      tags: tagTokens,
      credentialMode,
      selectedSecretRef,
      credentialUsername,
      credentialDomain,
      password,
      passphrase,
      privateKeyPem: privateKeyFile?.content,
      certificateText: certificateFile?.content,
      env: envVars,
    });
    const currentKey = serializeHostFormSubmission(submission);
    if (!isEditMode) {
      // 생성 모드에는 "저장된 상태" 가 없다. 손대지 않은 새 폼과 비교해, 아무것도 입력하지 않았으면
      // 버릴 것이 없다고 본다 — New Host 를 눌러 두고 다른 데를 클릭할 때마다 확인 창이 뜨면
      // 그 창은 곧 아무도 읽지 않는 창이 된다.
      //
      // 종류(SSH·RDP…)는 지금 폼의 종류로 맞춰 비교한다. 탭만 바꾼 것은 버릴 내용이 아니다.
      const pristineKind =
        draft.kind === 'rdp' || draft.kind === 'vnc' || draft.kind === 'serial'
          ? draft.kind
          : 'ssh';
      const pristineKey = serializeHostFormSubmission(
        buildHostFormSubmission({
          draft: createDraft(defaultGroupPath, pristineKind),
          tags: [],
          credentialMode: 'new',
          selectedSecretRef: '',
          password: '',
          passphrase: '',
        }),
      );
      return currentKey !== pristineKey;
    }
    return currentKey !== lastSavedSubmissionKey;
  }, [
    certificateFile?.content,
    credentialDomain,
    credentialMode,
    credentialUsername,
    defaultGroupPath,
    draft,
    envVars,
    isEditMode,
    lastSavedSubmissionKey,
    passphrase,
    password,
    privateKeyFile?.content,
    selectedSecretRef,
    tagTokens,
  ]);

  const submit = useCallback(async () => {
    if (!isEditMode) {
      return false;
    }
    if (!reportCurrentValidity()) {
      return false;
    }
    const didSave = await persistChanges({ commitPendingTag: true }).catch(() => false);
    if (!didSave) {
      return false;
    }
    // env는 호스트 레코드(드래프트)에 포함돼 persistChanges에서 함께 저장된다(시크릿과 분리).
    return true;
  }, [isEditMode, reportCurrentValidity, persistChanges]);

  useImperativeHandle(ref, () => ({
    submitCreate,
    submit,
    submitAndConnect,
    isDirty,
    setLabel: (label: string) => setDraft((prev) => ({ ...prev, label }))
  }), [isDirty, submit, submitAndConnect, submitCreate]);

  useEffect(() => {
    onActionStateChange?.({
      saveInFlight,
      saveStatusText: isEditMode ? saveStatusText : null
    });
  }, [isEditMode, onActionStateChange, saveInFlight, saveStatusText]);

  // draft.label 을 드로어 헤더의 편집 타이틀로 올려보낸다(호스트 하이드레이션·hostname 자동
  // 파생 등 폼 내부 변경도 헤더에 반영). 헤더 입력의 편집은 setLabel 로 여기 draft 에 되돌아온다.
  useEffect(() => {
    onLabelChange?.(draft.label);
  }, [draft.label, onLabelChange]);

  return (
    <>
    <form
      ref={formRef}
      className="flex flex-col gap-[0.9rem]"
      onSubmit={async (event) => {
        event.preventDefault();
        await submitCreate();
      }}
    >
      {hideTitle ? null : <div className="section-title">{translate('hostForm.title')}</div>}
      {/* 종류별 폼이 Details 섹션 안에서 직접 그린다. 여기 남은 것은 아직 옮기지 않은 종류를
          위한 자리다 — 그 종류만 폼 맨 위에 그룹·태그가 카드 밖으로 나온다.

          **옮긴 종류를 빼는 방식으로 쓰지 않는다.** 그렇게 두면 새 종류를 추가할 때마다 이 조건을
          기억해야 하고, 한 번 잊으면 그룹·태그가 두 번 그려진다(RDP·VNC 가 실제로 그랬다). 아직
          안 옮긴 종류를 적어 두면 새 종류는 저절로 제외된다. */}
      {draft.kind === 'warpgate-ssh' ? metadataFields : null}

      {isAwsEc2Draft ? (
        <>
          <FormSection
            title={translate('hostForm.section.connection')}
            description="Required to connect."
            testId="hostform-section-connection"
          >
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.awsProfile')}</span>
            <SelectField
              aria-label={translate('hostForm.field.awsProfile')}
              value={selectedAwsProfileValue}
              onChange={(event) => handleAwsProfileChange(event.target.value)}
              disabled={isLoadingAwsProfiles || awsProfileOptions.length === 0}
            >
              {awsProfileOptions.map((profile) => (
                <option key={profile.value} value={profile.value} disabled={profile.isMissingCurrent || profile.isUnconfigured}>
                  {profile.isMissingCurrent ? translate('hostForm.profile.missingCurrent', { name: profile.profileName }) : profile.profileName}
                </option>
              ))}
            </SelectField>
            {awsProfilesError ? (
              <span className="text-[0.82rem] text-[var(--danger-text)]">{awsProfilesError}</span>
            ) : null}
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.region')}</span>
            <Input value={draft.awsRegion} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.availabilityZone')}</span>
            <Input value={draft.awsAvailabilityZone ?? ''} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.instanceId')}</span>
            <Input value={draft.awsInstanceId} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.instanceName')}</span>
            <Input value={draft.awsInstanceName ?? ''} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.platform')}</span>
            <Input value={draft.awsPlatform ?? ''} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.privateIp')}</span>
            <Input value={draft.awsPrivateIp ?? ''} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.state')}</span>
            <Input value={draft.awsState ?? ''} readOnly />
          </label>
          <div className="flex flex-col gap-[0.4rem] rounded-[10px] border border-[color-mix(in_srgb,var(--accent-strong)_18%,var(--border)_82%)] bg-[color-mix(in_srgb,var(--surface-elevated)_76%,var(--surface)_24%)] px-[0.9rem] py-[0.9rem]">
            <strong>{getAwsEc2HostSshMetadataStatusLabel(draft.awsSshMetadataStatus) ?? translate('hostForm.awsSsh.pending')}</strong>
            <span className="text-[var(--text-soft)] leading-[1.5]">
              {draft.awsSshMetadataError
                ? draft.awsSshMetadataError
                : draft.awsSshMetadataStatus === 'loading'
                  ? translate('hostForm.awsSsh.loadingHint')
                  : translate('hostForm.awsSsh.manualHint')}
            </span>
          </div>
          <div className="grid gap-[0.7rem] md:grid-cols-[120px_minmax(0,1fr)]">
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.sshPort')}</span>
              <Input
                type="number"
                min={1}
                max={65535}
                value={draft.awsSshPort ?? 22}
                onChange={(event) =>
                  setDraft((current) =>
                    current.kind === 'aws-ec2'
                      ? {
                          ...current,
                          awsSshPort: Number(event.target.value) || 22
                        }
                      : current
                  )
                }
              />
            </label>
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.sshUsername')}</span>
              <Input
                value={draft.awsSshUsername ?? ''}
                onChange={(event) =>
                  setDraft((current) =>
                    current.kind === 'aws-ec2'
                      ? {
                          ...current,
                          awsSshUsername: event.target.value
                        }
                      : current
                  )
                }
                placeholder="ubuntu"
              />
            </label>
          </div>
          <ToggleSwitch
              checked={draft.awsSsmServerProxyEnabled === true}
              label={translate('hostForm.serverProxy.label')}
              description={translate('hostForm.serverProxy.description')}
              onClick={() =>
                  setDraft((current) =>
                      current.kind === 'aws-ec2'
                          ? {
                            ...current,
                            awsSsmServerProxyEnabled:
                                current.awsSsmServerProxyEnabled !== true
                          }
                          : current
                  )
              }
          />
          <ToggleSwitch
              checked={draft.agentForwarding === true}
              label={translate('hostForm.field.agentForwarding')}
              description={translate('hostForm.agentForward.awsDescription')}
              onClick={() =>
                  setDraft((current) =>
                      current.kind === 'aws-ec2'
                          ? {
                            ...current,
                            agentForwarding: current.agentForwarding !== true
                          }
                          : current
                  )
              }
          />
          </FormSection>

          <FormSection
            title={translate('hostForm.section.details')}
            description="How this host appears in the app."
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title={translate('hostForm.section.preferences')}
            description="Optional local preference."
            testId="hostform-section-preferences"
          >
            {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}
            {startupCommandField}
          </FormSection>
        </>
      ) : isAwsEcsDraft ? (
        <>
          <FormSection
            title={translate('hostForm.section.connection')}
            description="Required to connect."
            testId="hostform-section-connection"
          >
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.awsProfile')}</span>
            <SelectField
              aria-label={translate('hostForm.field.awsProfile')}
              value={selectedAwsProfileValue}
              onChange={(event) => handleAwsProfileChange(event.target.value)}
              disabled={isLoadingAwsProfiles || awsProfileOptions.length === 0}
            >
              {awsProfileOptions.map((profile) => (
                <option key={profile.value} value={profile.value} disabled={profile.isMissingCurrent || profile.isUnconfigured}>
                  {profile.isMissingCurrent ? translate('hostForm.profile.missingCurrent', { name: profile.profileName }) : profile.profileName}
                </option>
              ))}
            </SelectField>
            {awsProfilesError ? (
              <span className="text-[0.82rem] text-[var(--danger-text)]">{awsProfilesError}</span>
            ) : null}
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.region')}</span>
            <Input value={draft.awsRegion} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.ecsCluster')}</span>
            <Input value={draft.awsEcsClusterName} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.clusterArn')}</span>
            <Input value={draft.awsEcsClusterArn} readOnly />
          </label>
          </FormSection>

          <FormSection
            title={translate('hostForm.section.details')}
            description="How this host appears in the app."
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title={translate('hostForm.section.preferences')}
            description="Optional local preference."
            testId="hostform-section-preferences"
          >
            {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}
          </FormSection>
        </>
      ) : draft.kind === 'warpgate-ssh' ? (
        <>
          {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}
          {startupCommandField}

          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.warpgateUrl')}</span>
            <Input value={draft.warpgateBaseUrl} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.warpgateEndpoint')}</span>
            <Input value={`${draft.warpgateSshHost}:${draft.warpgateSshPort}`} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.warpgateTarget')}</span>
            <Input value={draft.warpgateTargetName} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.warpgateTargetId')}</span>
            <Input value={draft.warpgateTargetId} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>{translate('hostForm.field.warpgateUsername')}</span>
            <Input
              value={draft.warpgateUsername}
              onChange={(event) =>
                setDraft((current) =>
                  current.kind === 'warpgate-ssh'
                    ? {
                        ...current,
                        warpgateUsername: event.target.value
                      }
                    : current
                )
              }
              placeholder="example.user"
              required
            />
          </label>
        </>
      ) : sshDraft ? (
        <>
          <FormSection
            title={translate('hostForm.section.connection')}
            description="Required to connect."
            testId="hostform-section-connection"
          >
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.hostname')}</span>
              <Input
                value={sshDraft.hostname}
                onChange={(event) => handleSshHostnameChange(event.target.value)}
                placeholder="prod.example.com"
                required
              />
            </label>
            <div className="grid gap-[0.7rem] md:grid-cols-[120px_minmax(0,1fr)]">
              <label className={fieldClassName}>
                <span className={fieldLabelClassName}>{translate('hostForm.field.port')}</span>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={sshDraft.port}
                  onChange={(event) => setDraft({ ...sshDraft, port: Number(event.target.value) || 22 })}
                  required
                />
              </label>
              <label className={fieldClassName}>
                <span className={fieldLabelClassName}>{translate('hostForm.field.username')}</span>
                <Input
                  aria-label={translate('hostForm.field.username')}
                  value={sshDraft.username}
                  onChange={(event) => setDraft({ ...sshDraft, username: event.target.value })}
                  placeholder="ubuntu"
                />
              </label>
            </div>
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.authType')}</span>
              <SelectField
                value={sshDraft.authType}
                onChange={(event) => {
                  const value = event.target.value;
                  const nextAuthType =
                    value === 'privateKey'
                      ? 'privateKey'
                      : value === 'certificate'
                        ? 'certificate'
                        : value === 'agent'
                          ? 'agent'
                          : 'password';
                  setDraft({
                    ...sshDraft,
                    authType: nextAuthType,
                    privateKeyPath: null,
                    certificatePath: null
                  });
                  if (nextAuthType === 'password' || nextAuthType === 'agent') {
                    setPrivateKeyFile(null);
                    setCertificateFile(null);
                  } else if (nextAuthType === 'privateKey') {
                    setCertificateFile(null);
                  }
                }}
              >
                <option value="password">{translate('hostForm.option.authPassword')}</option>
                <option value="privateKey">{translate('hostForm.option.authPrivateKey')}</option>
                <option value="certificate">{translate('hostForm.option.authCertificate')}</option>
                <option value="agent">{translate('hostForm.option.authAgent')}</option>
              </SelectField>
            </label>

            {sshDraft.authType === 'agent' ? (
              <div className="grid gap-[0.45rem]">
                <p className="text-[0.8rem] leading-[1.5] text-[var(--text-soft)]">
                  {translate('hostForm.auth.agentHint')}
                </p>
                <div className="flex items-center gap-[0.5rem] text-[0.8rem]">
                  <span
                    aria-hidden="true"
                    className="inline-block h-[0.5rem] w-[0.5rem] shrink-0 rounded-full"
                    style={{ background: agentStatusColor(agentProbe?.status) }}
                  />
                  <span className="text-[var(--text-soft)]">
                    {agentStatusText(agentProbe)}
                  </span>
                </div>
              </div>
            ) : null}

            {sshDraft.authType === 'password' && credentialMode === 'new' ? (
              <label className={fieldClassName}>
                <span className={fieldLabelClassName}>{translate('hostForm.field.password')}</span>
                <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={host ? translate('hostForm.placeholder.keepBlank') : ''} />
              </label>
            ) : null}

            {credentialMode === 'new' && (sshDraft.authType === 'privateKey' || sshDraft.authType === 'certificate') ? (
              <>
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>{translate('hostForm.field.privateKeyFile')}</span>
                  <div className="flex gap-[0.7rem]">
                    <Input
                      readOnly
                      value={privateKeyFile?.name ?? ''}
                      placeholder="/Users/.../.ssh/id_ed25519"
                    />
                    <Button variant="secondary" onClick={pickPrivateKey}>
                      {translate('hostForm.action.import')}
                    </Button>
                  </div>
                </label>
                {sshDraft.authType === 'certificate' ? (
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>{translate('hostForm.field.certificateFile')}</span>
                    <div className="flex gap-[0.7rem]">
                      <Input
                        readOnly
                        value={certificateFile?.name ?? ''}
                        placeholder="/Users/.../.ssh/id_ed25519-cert.pub"
                      />
                      <Button variant="secondary" onClick={pickCertificate}>
                        {translate('hostForm.action.import')}
                      </Button>
                    </div>
                  </label>
                ) : null}
                {credentialMode === 'new' ? (
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>{translate('hostForm.field.passphrase')}</span>
                    <Input
                      type="password"
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      placeholder={host ? translate('hostForm.placeholder.keepBlank') : ''}
                    />
                  </label>
                ) : null}
              </>
            ) : null}

            {sshDraft.authType !== 'agent' ? (
            <div className="grid gap-[0.55rem]">
              {/* 여기에 설정 화면으로 보내는 '관리' 링크가 있었다. 편집하려고 눌렀다가 폼을 벗어나
                  버려서(작성 중이던 내용을 두고) 당황하는 자리였고, 바로 아래 '편집' 버튼과 역할이
                  겹쳤다. 자격증명 편집은 그 '편집' 이 담당하고, 목록 관리는 설정에서 한다. */}
              <span className={fieldLabelClassName}>{translate('hostForm.field.savedCredentials')}</span>
              <CredentialSelect
                ariaLabel={translate('hostForm.field.savedCredentials')}
                value={credentialMode === 'existing' ? `existing:${selectedSecretRef}` : credentialMode}
                entries={reusableEntries}
                onSelectNew={() => {
                  setCredentialMode('new');
                  setSelectedSecretRef('');
                }}
                onSelectExisting={(secretRef) => {
                  setCredentialMode('existing');
                  setSelectedSecretRef(secretRef);
                }}
              />
            </div>
            ) : null}

            {credentialMode === 'existing' && sshDraft.authType !== 'agent' ? (
              <div className="grid gap-[0.55rem]">
                {host && isSshHostRecord(host) && selectedSecretRef && onEditExistingSecret ? (
                  <Button
                    variant="secondary"
                    onClick={() => onEditExistingSecret(selectedSecretRef)}
                  >
                    {translate('hostForm.auth.edit')}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {/* 등록된 tailnet 이 없어도 칸은 보여 준다. 숨기면 이 기능이 있다는 것 자체를
                알 수 없고, 기기마다 따로 등록해야 하는 구조라 "다른 PC 에서는 없다"로
                보이기 때문이다. 대신 어디서 등록하는지 알려 준다. */}
            <div className={fieldClassName}>
              <div className="flex items-center justify-between gap-3">
                <span className={fieldLabelClassName}>{translate('hostForm.field.tailnet')}</span>
                {/* 자격증명 쪽과 달리 목록이 비어도 보여 준다 — 등록된 tailnet 이 없을 때가
                    오히려 여기로 갈 이유가 가장 큰 순간이다. */}
                {onOpenTailnets ? (
                  <button
                    type="button"
                    className="border-0 bg-transparent p-0 text-[0.9rem] font-semibold text-[var(--accent-strong)]"
                    onClick={onOpenTailnets}
                  >
                    {translate('hostForm.action.manage')}
                  </button>
                ) : null}
              </div>
              <SelectField
                value={selectedTailnetId}
                disabled={tailnetOptions.length === 0 && !missingTailnetId}
                onChange={(event) =>
                  setDraft({
                    ...sshDraft,
                    tailnetId: event.target.value || null,
                  })
                }
              >
                <option value="">{translate('hostForm.tailnet.none')}</option>
                {missingTailnetId ? (
                  <option value={missingTailnetId}>
                    {translate('hostForm.tailnet.missingOption')}
                  </option>
                ) : null}
                {tailnetOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
              {/* 고를 것이 있으면 설명을 붙이지 않는다. 비어 있을 때만 안내가 필요하다 —
                  tailnet 은 기기마다 따로 등록해야 해서 "다른 PC 에는 있는데" 로 헷갈린다. */}
              {missingTailnetId ? (
                <span className="text-[0.82rem] text-[var(--danger)]">
                  {translate('hostForm.tailnet.missing')}
                </span>
              ) : tailnetOptions.length === 0 ? (
                <span className="text-[0.82rem] text-[var(--text-soft)]">
                  {translate('hostForm.tailnet.empty')}
                </span>
              ) : null}
            </div>

            <div className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.jumpHosts')}</span>
              <JumpHostChainEditor
                value={jumpHostChain}
                candidates={jumpHostOptions}
                disabled={sshDraft.useMosh === true && jumpHostChain.length === 0}
                onChange={commitJumpHostChain}
              />
              <span className="text-[0.82rem] text-[var(--text-soft)]">
                {translate('hostForm.jump.description')}
              </span>
              {/* 첫 홉에 tailnet 이 걸려 있으면 접속은 그것을 탄다. 이 호스트에 따로 걸어 둔
                  설정은 쓰이지 않으므로, 그 사실을 여기서 말해 준다. */}
              {entryHopTailnetName ? (
                <span
                  className={
                    selectedTailnetId
                      ? 'text-[0.82rem] text-[var(--danger)]'
                      : 'text-[0.82rem] text-[var(--text-soft)]'
                  }
                >
                  {selectedTailnetId
                    ? translate('hostForm.jump.tailnetOverridden', {
                        jump: entryHopLabel,
                        tailnet: entryHopTailnetName,
                      })
                    : translate('hostForm.jump.tailnetFromEntryHop', {
                        jump: entryHopLabel,
                        tailnet: entryHopTailnetName,
                      })}
                </span>
              ) : null}
            </div>
            <div className={fieldClassName}>
              <ToggleSwitch
                label={translate('hostForm.mosh.label')}
                description={
                  jumpHostChain.length > 0
                    ? translate('hostForm.mosh.jumpConflict')
                    : translate('hostForm.mosh.description')
                }
                checked={sshDraft.useMosh === true && jumpHostChain.length === 0}
                disabled={jumpHostChain.length > 0}
                onClick={() =>
                  setDraft({
                    ...sshDraft,
                    useMosh: sshDraft.useMosh !== true,
                    agentForwarding:
                      sshDraft.useMosh !== true
                        ? null
                        : sshDraft.agentForwarding,
                  })
                }
              />
            </div>
            <div className={fieldClassName}>
              <ToggleSwitch
                label={translate('hostForm.field.agentForwarding')}
                description={
                  sshDraft.useMosh === true
                    ? translate('hostForm.agentForward.moshUnsupported')
                    : translate('hostForm.agentForward.description')
                }
                checked={
                  sshDraft.agentForwarding === true &&
                  sshDraft.useMosh !== true
                }
                disabled={sshDraft.useMosh === true}
                onClick={() =>
                  setDraft({
                    ...sshDraft,
                    agentForwarding: sshDraft.agentForwarding !== true,
                  })
                }
              />
            </div>
          </FormSection>

          <FormSection
            title={translate('hostForm.section.details')}
            description="How this host appears in the app."
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title={translate('hostForm.section.preferences')}
            description="Optional local preference."
            testId="hostform-section-preferences"
          >
            {renderTerminalThemeField(sshDraft.terminalThemeId ?? null, (terminalThemeId) => setDraft({ ...sshDraft, terminalThemeId }))}
            {startupCommandField}
            <div className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.envVars')}</span>
              <EnvironmentVariablesEditor
                variables={envVars}
                onChange={setEnvVars}
              />
              <span className="text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                {translate('hostForm.env.description')}
              </span>
            </div>
          </FormSection>
        </>
      ) : serialDraft ? (
        <>
          <FormSection
            title={translate('hostForm.section.connection')}
            description="Configure the serial transport and terminal behavior."
            testId="hostform-section-connection"
          >
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.transport')}</span>
              <SelectField
                value={serialDraft.transport}
                onChange={(event) => {
                  const nextTransport =
                    event.target.value === 'raw-tcp'
                      ? 'raw-tcp'
                      : event.target.value === 'rfc2217'
                        ? 'rfc2217'
                        : 'local';
                  handleSerialFieldChange('transport', nextTransport);
                }}
              >
                <option value="local">{translate('hostForm.option.transportLocal')}</option>
                <option value="raw-tcp">Raw TCP</option>
                <option value="rfc2217">RFC2217</option>
              </SelectField>
            </label>

            {serialDraft.transport === 'local' ? (
              <>
                <div className="grid gap-[0.55rem]">
                  <div className="flex items-center justify-between gap-3">
                    <span className={fieldLabelClassName}>{translate('hostForm.field.detectedPorts')}</span>
                    <Button variant="secondary" onClick={() => void refreshSerialPorts()}>
                      {translate('hostForm.action.refresh')}
                    </Button>
                  </div>
                  <SelectField
                    aria-label={translate('hostForm.field.detectedPortAria')}
                    value={
                      serialPorts.some((port) => port.path === (serialDraft.devicePath ?? ''))
                        ? serialDraft.devicePath ?? ''
                        : ''
                    }
                    onChange={(event) => handleSerialFieldChange('devicePath', event.target.value)}
                  >
                    <option value="">{translate('hostForm.option.selectDetectedPort')}</option>
                    {serialPorts.map((port) => (
                      <option key={port.path} value={port.path}>
                        {port.displayName}
                      </option>
                    ))}
                  </SelectField>
                  {serialPortsError ? (
                    <span className="text-[0.82rem] text-[var(--danger-text)]">{serialPortsError}</span>
                  ) : isLoadingSerialPorts ? (
                    <span className="text-[0.82rem] text-[var(--text-soft)]">{translate('hostForm.serial.loadingPorts')}</span>
                  ) : null}
                </div>
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>{translate('hostForm.field.devicePath')}</span>
                  <Input
                    value={serialDraft.devicePath ?? ''}
                    onChange={(event) => handleSerialFieldChange('devicePath', event.target.value)}
                    placeholder={desktopPlatform === 'win32' ? 'COM3' : '/dev/tty.usbserial-0001'}
                    required
                  />
                </label>
              </>
            ) : (
              <div className="grid gap-[0.7rem] md:grid-cols-[minmax(0,1fr)_120px]">
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>{translate('hostForm.field.remoteHost')}</span>
                  <Input
                    value={serialDraft.host ?? ''}
                    onChange={(event) => handleSerialFieldChange('host', event.target.value)}
                    placeholder="serial-gateway.local"
                    required
                  />
                </label>
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>{translate('hostForm.field.port')}</span>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={serialDraft.port ?? 4001}
                    onChange={(event) => handleSerialFieldChange('port', Number(event.target.value) || 4001)}
                    required
                  />
                </label>
              </div>
            )}

            {serialDraft.transport !== 'raw-tcp' ? (
              <>
                <div className="grid gap-[0.7rem] md:grid-cols-2">
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>{translate('hostForm.field.baudRate')}</span>
                    <Input
                      type="number"
                      min={1}
                      value={serialDraft.baudRate}
                      onChange={(event) => handleSerialFieldChange('baudRate', Number(event.target.value) || 115200)}
                      required
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>{translate('hostForm.field.dataBits')}</span>
                    <SelectField
                      value={String(serialDraft.dataBits)}
                      onChange={(event) => handleSerialFieldChange('dataBits', Number(event.target.value) as SerialHostDraft['dataBits'])}
                    >
                      <option value="5">5</option>
                      <option value="6">6</option>
                      <option value="7">7</option>
                      <option value="8">8</option>
                    </SelectField>
                  </label>
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>{translate('hostForm.field.parity')}</span>
                    <SelectField
                      value={serialDraft.parity}
                      onChange={(event) => handleSerialFieldChange('parity', event.target.value as SerialHostDraft['parity'])}
                    >
                      <option value="none">{translate('hostForm.option.none')}</option>
                      <option value="odd">{translate('hostForm.option.parityOdd')}</option>
                      <option value="even">{translate('hostForm.option.parityEven')}</option>
                      <option value="mark">Mark</option>
                      <option value="space">Space</option>
                    </SelectField>
                  </label>
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>{translate('hostForm.field.stopBits')}</span>
                    <SelectField
                      value={String(serialDraft.stopBits)}
                      onChange={(event) =>
                        handleSerialFieldChange(
                          'stopBits',
                          (event.target.value === '1.5' ? 1.5 : Number(event.target.value)) as SerialHostDraft['stopBits']
                        )
                      }
                    >
                      <option value="1">1</option>
                      <option value="1.5">1.5</option>
                      <option value="2">2</option>
                    </SelectField>
                  </label>
                </div>
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>{translate('hostForm.field.flowControl')}</span>
                  <SelectField
                    value={serialDraft.flowControl}
                    onChange={(event) => handleSerialFieldChange('flowControl', event.target.value as SerialHostDraft['flowControl'])}
                  >
                    <option value="none">{translate('hostForm.option.none')}</option>
                    <option value="xon-xoff">XON/XOFF</option>
                    <option value="rts-cts">RTS/CTS</option>
                    <option value="dsr-dtr">DSR/DTR</option>
                  </SelectField>
                </label>
              </>
            ) : null}

            <div className="grid gap-[0.7rem]">
              <ToggleSwitch
                checked={serialDraft.localEcho}
                label={translate('hostForm.field.localEcho')}
                description={translate('hostForm.serial.localEchoDesc')}
                onClick={() => handleSerialFieldChange('localEcho', !serialDraft.localEcho)}
              />
              <ToggleSwitch
                checked={serialDraft.localLineEditing}
                label={translate('hostForm.field.localLineEditing')}
                description={translate('hostForm.serial.localLineEditingDesc')}
                onClick={() => handleSerialFieldChange('localLineEditing', !serialDraft.localLineEditing)}
              />
            </div>
          </FormSection>

          <FormSection
            title={translate('hostForm.section.details')}
            description="How this host appears in the app."
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title={translate('hostForm.section.preferences')}
            description="Optional local preference."
            testId="hostform-section-preferences"
          >
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.lineEnding')}</span>
              <SelectField
                aria-label={translate('hostForm.field.lineEnding')}
                value={serialDraft.transmitLineEnding}
                onChange={(event) =>
                  handleSerialFieldChange(
                    'transmitLineEnding',
                    event.target.value as SerialHostDraft['transmitLineEnding'],
                  )
                }
              >
                <option value="none">{translate('hostForm.option.none')}</option>
                <option value="cr">CR</option>
                <option value="lf">LF</option>
                <option value="crlf">CRLF</option>
              </SelectField>
            </label>
            {renderTerminalThemeField(serialDraft.terminalThemeId ?? null, (terminalThemeId) => setDraft({ ...serialDraft, terminalThemeId }))}
          </FormSection>
        </>
      ) : vncDraft ? (
        <>
          <FormSection
            title={translate('hostForm.section.connection')}
            testId="hostform-section-connection"
          >
            {/* 터널을 거치면 이 주소의 뜻이 바뀐다 — **경유 서버에서 본** 대상이다. 라벨을 그대로
                두면 사용자는 자기 PC 에서 닿는 주소를 넣고 "왜 안 되지" 가 된다. */}
            <div className={fieldClassName}>
              <label className={fieldLabelClassName} htmlFor="hostform-vnc-hostname">
                {vncTunnelHostId
                  ? translate('hostForm.vnc.tunnel.targetLabel')
                  : translate('hostForm.field.hostname')}
              </label>
              <Input
                id="hostform-vnc-hostname"
                value={vncDraft.hostname}
                onChange={(event) => handleVncFieldChange('hostname', event.target.value)}
                placeholder={vncTunnelHostId ? '127.0.0.1' : '192.168.0.10'}
                aria-describedby={
                  vncTunnelHostId ? 'hostform-vnc-target-hint' : undefined
                }
                required
              />
              {/* 설명은 label 밖에 둔다. 안에 넣으면 이 칸의 이름이 "대상 주소…설명" 전체가 된다
                  — 화면 낭독기와 테스트가 칸을 못 찾는다. */}
              {vncTunnelHostId ? (
                <span
                  id="hostform-vnc-target-hint"
                  className="text-[0.82rem] text-[var(--text-soft)]"
                >
                  {translate('hostForm.vnc.tunnel.targetHint')}
                </span>
              ) : null}
            </div>

            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.port')}</span>
              <Input
                type="number"
                min={1}
                max={65535}
                value={String(vncDraft.port)}
                onChange={(event) =>
                  handleVncFieldChange('port', Number.parseInt(event.target.value, 10) || 5900)
                }
                required
              />
            </label>

            {/* VNC 는 비밀번호 하나만 쓴다 — 계정이라는 개념이 없다. 서버를 인증 없이 열어 둔
                경우도 흔하므로 비워 둘 수 있다. */}
            <div className={fieldClassName}>
              <div className="flex items-center justify-between gap-3">
                <span className={fieldLabelClassName}>
                  {translate('hostForm.vnc.credential')}
                </span>
                {credentialMode === 'existing' && selectedSecretRef && onEditExistingSecret ? (
                  <button
                    type="button"
                    className="border-0 bg-transparent p-0 text-[0.9rem] font-semibold text-[var(--accent-strong)]"
                    onClick={() => onEditExistingSecret(selectedSecretRef)}
                  >
                    {translate('hostForm.auth.edit')}
                  </button>
                ) : null}
              </div>
              <CredentialSelect
                ariaLabel={translate('hostForm.vnc.credential')}
                value={
                  credentialMode === 'existing' ? `existing:${selectedSecretRef}` : credentialMode
                }
                entries={vncReusableEntries}
                missingEntry={vncSelectedMissingEntry}
                onSelectNew={() => {
                  setCredentialMode('new');
                  setSelectedSecretRef('');
                }}
                onSelectExisting={(secretRef) => {
                  setCredentialMode('existing');
                  setSelectedSecretRef(secretRef);
                }}
              />
            </div>

            {credentialMode === 'new' ? (
              <div className={fieldClassName}>
                {/* 길이 제한을 안내하지 않는다. 8바이트로 자르는 것은 VncAuth 뿐이고 서버도 같이
                    자르니 실패하지 않으며, ARD(macOS 화면 공유)는 비밀번호 전체를 쓴다. 어느
                    인증을 쓸지는 접속해 봐야 정해지므로 여기서 말할 수 있는 사실이 아니다. */}
                <label
                  className={fieldLabelClassName}
                  htmlFor="hostform-vnc-password"
                >
                  {translate('hostForm.field.password')}
                </label>
                <Input
                  id="hostform-vnc-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  // 계정만 넣으면 자격증명을 만들지 않는다(비밀번호 없는 자격증명은 인증에 쓸 수
                  // 없다). 그런데 그것을 말해 주지 않으면 입력한 계정이 조용히 사라진다 —
                  // 여기서 막고 위 문구로 이유를 보여 준다.
                  required={accountNeedsPassword}
                />
                {/* 계정은 서버가 VeNCrypt 의 Plain 계열을 쓸 때만 필요하다. 대부분의 VNC 서버는
                    비밀번호만 쓰므로 비워 두는 것이 기본이고, 비어 있으면 코어가 계정을 요구하는
                    방식을 아예 고르지 않는다 — 빈 계정으로 붙으려다 실패하면 그 이유가 비밀번호
                    오류와 구분되지 않는다. */}
                <label
                  className={fieldLabelClassName}
                  htmlFor="hostform-vnc-username"
                >
                  {translate('hostForm.vnc.account')}
                </label>
                <Input
                  id="hostform-vnc-username"
                  aria-describedby="hostform-vnc-username-hint"
                  value={credentialUsername}
                  onChange={(event) => setCredentialUsername(event.target.value)}
                />
                <span
                  id="hostform-vnc-username-hint"
                  className={`text-[0.85rem] ${
                    accountNeedsPassword
                      ? 'text-[var(--danger,#e2504a)]'
                      : 'text-[var(--text-muted)]'
                  }`}
                >
                  {accountNeedsPassword
                    ? translate('hostForm.vnc.accountNeedsPassword')
                    : translate('hostForm.vnc.accountHint')}
                </span>
              </div>
            ) : null}

            {/* SSH 터널. QEMU·libvirt 콘솔은 5900 을 localhost 에만 바인딩하는 것이 관행이라
                이 경로가 아니면 아예 닿지 않는다.

                tailnet 과 상호배타다. 접속 경로(ipc/vnc.ts 의 openForward)가 tailnetId 를 먼저
                보고 거기서 끝내므로 둘 다 정하면 터널이 조용히 무시된다. 그리고 배타로 두어도
                잃는 것이 없다 — 터널은 고른 SSH 호스트의 tailnet 설정을 그대로 타므로
                (resolveTailnetRoute) tailnet 뒤의 VNC 서버도 터널로 닿는다. */}
            <div className={fieldClassName}>
              <span className={fieldLabelClassName}>
                {translate('hostForm.vnc.tunnel.label')}
              </span>
              {/* 점프 호스트와 같은 검색 가능한 목록을 쓴다 — 호스트가 늘면 평범한 select 에서는
                  찾을 수 없고, 고르는 대상이 같은 종류(저장된 SSH 호스트)라 조작도 같아야 한다. */}
              <SearchableSelect
                ariaLabel={translate('hostForm.vnc.tunnel.label')}
                placeholder={translate('hostForm.vnc.tunnel.none')}
                searchPlaceholder={translate('hostForm.jump.searchPlaceholder')}
                value={vncTunnelHostId}
                options={vncTunnelOptions}
                disabled={jumpHostOptions.length === 0 || Boolean(vncTailnetId)}
                onChange={(next) => selectVncTunnelHost(next || null)}
              />
              <span
                className={`text-[0.82rem] ${
                  vncTunnelMissing ? 'text-[var(--danger)]' : 'text-[var(--text-soft)]'
                }`}
              >
                {vncTunnelMissing
                  ? translate('hostForm.vnc.tunnel.missing')
                  : jumpHostOptions.length === 0
                    ? translate('hostForm.vnc.tunnel.empty')
                    : vncTailnetId
                      ? translate('hostForm.vnc.tunnel.lockedByTailnet')
                      : translate('hostForm.vnc.tunnel.hint')}
              </span>
            </div>

            {renderTailnetField(
              vncDraft.tailnetId,
              (tailnetId) => handleVncFieldChange('tailnetId', tailnetId),
              vncTunnelHostId ? translate('hostForm.vnc.tunnel.tailnetLocked') : null,
            )}
          </FormSection>

          {/* 다른 종류와 같은 순서다: Connection 다음이 Details. */}
          <FormSection
            title={translate('hostForm.section.details')}
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title={translate('hostForm.section.preferences')}
            testId="hostform-section-preferences"
          >
            <ToggleSwitch
              checked={vncDraft.shared !== false}
              label={translate('hostForm.vnc.shared.label')}
              description={translate('hostForm.vnc.shared.description')}
              onClick={() =>
                handleVncFieldChange('shared', vncDraft.shared === false ? null : false)
              }
            />

            <ToggleSwitch
              checked={vncDraft.viewOnly === true}
              label={translate('hostForm.vnc.viewOnly.label')}
              description={translate('hostForm.vnc.viewOnly.description')}
              onClick={() =>
                handleVncFieldChange('viewOnly', vncDraft.viewOnly === true ? null : true)
              }
            />

            {/* 화질. 기본은 무손실이다 — 서버는 우리가 품질을 선언할 때만 JPEG 를 쓴다(실측:
                선언 없으면 JPEG 0개, balanced 로 81개). 글자가 뭉개지는 것은 사용자가 고를 일이다. */}
            <div className={fieldClassName}>
              <label className={fieldLabelClassName} htmlFor="hostform-vnc-quality">
                {translate('hostForm.vnc.quality.label')}
              </label>
              <SelectField
                id="hostform-vnc-quality"
                value={vncDraft.imageQuality ?? 'lossless'}
                onChange={(event) =>
                  handleVncFieldChange(
                    'imageQuality',
                    event.target.value === 'lossless'
                      ? null
                      : (event.target.value as 'balanced' | 'fast'),
                  )
                }
              >
                <option value="lossless">
                  {translate('hostForm.vnc.quality.lossless')}
                </option>
                <option value="balanced">
                  {translate('hostForm.vnc.quality.balanced')}
                </option>
                <option value="fast">{translate('hostForm.vnc.quality.fast')}</option>
              </SelectField>
              <span className="text-[0.85rem] text-[var(--text-muted)]">
                {translate('hostForm.vnc.quality.hint')}
              </span>
            </div>
          </FormSection>
        </>
      ) : rdpDraft ? (
        <>
          <FormSection
            title={translate('hostForm.section.connection')}
            testId="hostform-section-connection"
          >
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.hostname')}</span>
              <Input
                value={rdpDraft.hostname}
                onChange={(event) => handleRdpFieldChange('hostname', event.target.value)}
                placeholder="192.168.0.10"
                required
              />
            </label>

            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.field.port')}</span>
              <Input
                type="number"
                min={1}
                max={65535}
                value={String(rdpDraft.port)}
                onChange={(event) =>
                  handleRdpFieldChange('port', Number.parseInt(event.target.value, 10) || 3389)
                }
                required
              />
            </label>

            {/* 계정은 자격증명에 딸린다 — Windows 의 DOMAIN\user+비밀번호가 한 묶음이고, 같은
                계정을 여러 호스트에 쓸 때 다시 적지 않아도 된다. */}
            <div className={fieldClassName}>
              <div className="flex items-center justify-between gap-3">
                <span className={fieldLabelClassName}>
                  {translate('hostForm.rdp.credential')}
                </span>
                {credentialMode === 'existing' && selectedSecretRef && onEditExistingSecret ? (
                  <button
                    type="button"
                    className="border-0 bg-transparent p-0 text-[0.9rem] font-semibold text-[var(--accent-strong)]"
                    onClick={() => onEditExistingSecret(selectedSecretRef)}
                  >
                    {translate('hostForm.auth.edit')}
                  </button>
                ) : null}
              </div>
              <CredentialSelect
                ariaLabel={translate('hostForm.rdp.credential')}
                value={
                  credentialMode === 'existing' ? `existing:${selectedSecretRef}` : credentialMode
                }
                entries={rdpReusableEntries}
                missingEntry={rdpSelectedMissingEntry}
                accountFirst
                onSelectNew={() => {
                  setCredentialMode('new');
                  setSelectedSecretRef('');
                }}
                onSelectExisting={(secretRef) => {
                  setCredentialMode('existing');
                  setSelectedSecretRef(secretRef);
                }}
              />
            </div>

            {credentialMode === 'new' ? (
              <>
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>
                    {translate('hostForm.field.username')}
                  </span>
                  <Input
                    value={credentialUsername}
                    onChange={(event) => setCredentialUsername(event.target.value)}
                    required
                  />
                </label>

                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>{translate('hostForm.rdp.domain')}</span>
                  <Input
                    value={credentialDomain}
                    onChange={(event) => setCredentialDomain(event.target.value)}
                    placeholder={translate('hostForm.rdp.domainPlaceholder')}
                  />
                </label>

                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>
                    {translate('hostForm.field.password')}
                  </span>
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              </>
            ) : null}

            <ToggleSwitch
              checked={rdpDraft.adminSession === true}
              label={translate('hostForm.rdp.adminSession.label')}
              onClick={() =>
                handleRdpFieldChange(
                  'adminSession',
                  rdpDraft.adminSession === true ? null : true,
                )
              }
            />

            {renderTailnetField(rdpDraft.tailnetId, (tailnetId) =>
              handleRdpFieldChange('tailnetId', tailnetId),
            )}
          </FormSection>

          {/* 다른 종류와 같은 순서다: Connection 다음이 Details. */}
          <FormSection
            title={translate('hostForm.section.details')}
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title={translate('hostForm.section.preferences')}
            testId="hostform-section-preferences"
          >
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>{translate('hostForm.rdp.colorQuality')}</span>
              <SelectField
                value={rdpDraft.colorDepth === 16 ? '16' : '32'}
                onChange={(event) =>
                  handleRdpFieldChange('colorDepth', event.target.value === '16' ? 16 : null)
                }
              >
                <option value="32">{translate('hostForm.rdp.color32')}</option>
                <option value="16">{translate('hostForm.rdp.color16')}</option>
              </SelectField>
            </label>

            <ToggleSwitch
              checked={rdpDraft.useAllMonitors === true}
              label={translate('hostForm.rdp.useAllMonitors.label')}
              onClick={() =>
                handleRdpFieldChange(
                  'useAllMonitors',
                  rdpDraft.useAllMonitors === true ? null : true,
                )
              }
            />

            <ToggleSwitch
              checked={rdpDraft.audioEnabled !== false}
              label={translate('hostForm.rdp.audio.label')}
              onClick={() =>
                handleRdpFieldChange(
                  'audioEnabled',
                  rdpDraft.audioEnabled === false ? null : false,
                )
              }
            />
            {/* 마이크는 기본이 꺼짐이라 토글 방향이 소리와 반대다 — 켠 경우에만 참을 저장한다. */}
            <ToggleSwitch
              checked={rdpDraft.microphoneEnabled === true}
              label={translate('hostForm.rdp.microphone.label')}
              description={translate('hostForm.rdp.microphone.description')}
              onClick={() =>
                handleRdpFieldChange(
                  'microphoneEnabled',
                  rdpDraft.microphoneEnabled === true ? null : true,
                )
              }
            />
            {/* 카메라도 기본이 꺼짐이다(마이크와 같은 이유). */}
            <ToggleSwitch
              checked={rdpDraft.cameraEnabled === true}
              label={translate('hostForm.rdp.camera.label')}
              description={translate('hostForm.rdp.camera.description')}
              onClick={() =>
                handleRdpFieldChange(
                  'cameraEnabled',
                  rdpDraft.cameraEnabled === true ? null : true,
                )
              }
            />
            <ToggleSwitch
              checked={rdpDraft.clipboardEnabled !== false}
              label={translate('hostForm.rdp.clipboard.label')}
              onClick={() =>
                handleRdpFieldChange(
                  'clipboardEnabled',
                  rdpDraft.clipboardEnabled === false ? null : false,
                )
              }
            />
          </FormSection>

          <FormSection
            title={translate('hostForm.rdp.drive.title')}
            testId="hostform-section-drive"
          >
            {/* 이름은 저장하지 않는다 — 경로에서 만든 값을 보여주고, 그 값이 원격에 그대로
                뜬다(describeRdpDrives 한 곳에서 만든다).

                한 줄에 이름·경로를 나란히 두지 않는다. 이름은 경로의 마지막 조각이라 폭을
                나눠 가지면 좁은 패널에서 둘 중 하나가 늘 잘렸다. 위아래로 쌓으면 둘 다 온전히
                보이고 머리글 행도 필요 없다. */}
            {rdpDrives.length > 0 ? (
              <div
                className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)]"
                data-testid="hostform-rdp-drives"
              >
                {rdpDrives.map((drive, index) => (
                  <div
                    key={`${drive.path}-${index}`}
                    className="flex items-center gap-[0.6rem] border-b border-[var(--border)] px-[0.75rem] py-[0.55rem] last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.9rem] text-[var(--text)]" title={drive.name}>
                        {drive.name}
                      </div>
                      <div
                        className="truncate text-[0.78rem] text-[var(--text-soft)]"
                        title={drive.path}
                      >
                        {drive.path}
                      </div>
                    </div>
                    {/* 머리글이 없으니 뜻은 라벨로 남긴다. 표 칸에는 체크박스가 맞다 —
                        ToggleSwitch 는 라벨+설명 한 줄 전용이라 여기서는 늘어난다. */}
                    <label
                      className="flex shrink-0 items-center gap-[0.35rem] text-[0.78rem] text-[var(--text-soft)]"
                      title={translate('hostForm.rdp.drive.readOnly')}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--accent-strong)]"
                        checked={drive.readOnly}
                        aria-label={`${drive.name} ${translate('hostForm.rdp.drive.readOnly')}`}
                        onChange={(event) =>
                          handleRdpFieldChange(
                            'drives',
                            (rdpDraft.drives ?? []).map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, readOnly: event.target.checked ? true : null }
                                : entry,
                            ),
                          )
                        }
                      />
                      {translate('hostForm.rdp.drive.readOnly')}
                    </label>
                    <IconButton
                      type="button"
                      tone="ghost"
                      size="sm"
                      className="shrink-0"
                      aria-label={`${drive.name} ${translate('hostForm.rdp.drive.remove')}`}
                      onClick={() =>
                        handleRdpFieldChange(
                          'drives',
                          (rdpDraft.drives ?? []).filter(
                            (_entry, entryIndex) => entryIndex !== index,
                          ),
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </IconButton>
                  </div>
                ))}
              </div>
            ) : null}
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  // 빈 행을 만들지 않는다 — 경로 없는 행은 아무 의미가 없고, 저장 계층이
                  // 어차피 버린다. 고른 폴더로 바로 행이 생긴다.
                  void pickRdpShareFolder().then((picked) => {
                    if (picked) {
                      handleRdpFieldChange('drives', [
                        ...(rdpDraft.drives ?? []),
                        { path: picked, readOnly: null },
                      ]);
                    }
                  });
                }}
              >
                <FolderPlus className="h-4 w-4" aria-hidden />
                {translate('hostForm.rdp.drive.add')}
              </Button>
            </div>
          </FormSection>
        </>
      ) : null}

    </form>
    </>
  );
});
