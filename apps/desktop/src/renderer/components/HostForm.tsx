import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { MAX_HOST_STARTUP_COMMAND_LENGTH, getAwsEc2HostSshMetadataStatusLabel, isAwsEc2HostRecord, isAwsEcsHostRecord, isSerialHostDraft, isSerialHostRecord, isSshHostDraft, isSshHostRecord, isWarpgateSshHostRecord } from '@shared';
import type { AwsProfileSummary, HostDraft, HostEnvVar, HostRecord, HostSecretInput, HostStartupCommand, SecretMetadataRecord, SerialHostDraft, SerialPortSummary, SnippetRecord, SshAgentProbeResult, SshHostDraft, SshHostRecord, TerminalThemeId } from '@shared';
import { useHostFormController } from '../controllers/useHostFormController';
import { EnvironmentVariablesEditor } from './EnvironmentVariablesEditor';
import { loadSavedCredential } from '../services/desktop/settings';
import { formatSavedSecretOptionLabel } from '../lib/secret-display';
import { terminalThemePresets } from '../lib/terminal-presets';
import { listAwsProfiles } from '../services/desktop/imports';
import { Button, Input, SearchableSelect, SelectField, TagInputField, Textarea, ToggleSwitch } from '../ui';
import type { SearchableSelectOption } from '../ui';
import { ArrowDown, ArrowUp, X } from '../ui/icons';

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
    return '에이전트 상태 확인 중…';
  }
  switch (probe.status) {
    case 'ok':
      return `에이전트 감지됨${
        typeof probe.keyCount === 'number' ? ` · 키 ${probe.keyCount}개` : ''
      }`;
    case 'empty':
      return '에이전트에 등록된 키가 없습니다';
    case 'unreachable':
      return '에이전트에 연결할 수 없습니다';
    case 'not-found':
      return '에이전트를 찾을 수 없습니다';
    default:
      return '에이전트 상태를 확인할 수 없습니다';
  }
}

const defaultSshDraft: SshHostDraft = {
  kind: 'ssh',
  label: '',
  tags: [],
  hostname: '',
  port: 22,
  username: '',
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
              placeholder="점프 호스트 선택"
              searchPlaceholder="이름, 호스트, 사용자 검색"
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
            aria-label={`${index + 1}번째 점프 위로`}
            disabled={disabled || index === 0}
            onClick={() => move(index, -1)}
          >
            <ArrowUp className="h-[0.95rem] w-[0.95rem]" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label={`${index + 1}번째 점프 아래로`}
            disabled={disabled || index === value.length - 1}
            onClick={() => move(index, 1)}
          >
            <ArrowDown className="h-[0.95rem] w-[0.95rem]" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label={`${index + 1}번째 점프 제거`}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <X className="h-[1rem] w-[1rem]" />
          </button>
        </div>
      ))}
      {remaining.length > 0 ? (
        <SearchableSelect
          ariaLabel="점프 호스트 추가"
          placeholder={value.length === 0 ? 'None (direct)' : '점프 호스트 추가…'}
          searchPlaceholder="이름, 호스트, 사용자 검색"
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

function createDraft(defaultGroupPath?: string | null, kind: 'ssh' | 'serial' = 'ssh'): HostDraft {
  if (kind === 'serial') {
    return {
      ...defaultSerialDraft,
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
  snippets?: SnippetRecord[];
  defaultGroupPath?: string | null;
  createKind?: 'ssh' | 'serial';
  desktopPlatform?: 'darwin' | 'win32' | 'linux' | 'unknown';
  hideTitle?: boolean;
  onSubmit: (draft: HostDraft, secrets?: HostSecretInput) => Promise<void>;
  onConnect?: (hostId: string) => Promise<void>;
  onEditExistingSecret?: (secretRef: string) => void;
  onOpenSecrets?: () => void;
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
        Terminal Theme
      </span>
      <SelectField
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? (event.target.value as TerminalThemeId) : null)}
      >
        <option value="">Use global theme</option>
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
  snippets = [],
  defaultGroupPath = null,
  createKind = 'ssh',
  desktopPlatform = 'unknown',
  hideTitle = false,
  onSubmit,
  onConnect,
  onEditExistingSecret,
  onOpenSecrets,
  onActionStateChange,
  onLabelChange
}: HostFormProps, ref) {
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
  const jumpHostChain = sshDraft ? deriveJumpChain(sshDraft) : [];
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
      if (sshDraft.authType === 'password') {
        return entry.hasPassword;
      }
      if (sshDraft.authType === 'certificate') {
        return entry.hasManagedPrivateKey && entry.hasCertificate;
      }
      return entry.hasManagedPrivateKey;
    });
  }, [keychainEntries, sshDraft]);
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
      options.unshift({
        value: currentProfileId ?? `missing:${currentProfileName}`,
        profileId: currentProfileId,
        profileName: currentProfileName || 'Unknown',
        isMissingCurrent: true,
      });
    }
    return options;
  }, [awsProfiles, draft, isAwsDraft]);
  const selectedAwsProfileValue = useMemo(() => {
    if (!isAwsDraft) {
      return '';
    }
    return draft.awsProfileId ?? `missing:${draft.awsProfileName.trim()}`;
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

  // 구버전 호스트(env가 아직 시크릿 번들에만 있는 경우)용 폴백: 호스트 레코드에 env가 없을 때만
  // 시크릿을 복호화해 읽어와 보여준다. 저장하면 호스트 레코드(드래프트)로 이전된다.
  useEffect(() => {
    if (!sshDraft || credentialMode !== 'existing' || !selectedSecretRef) {
      return;
    }
    if (host && host.kind === 'ssh' && Array.isArray(host.env) && host.env.length > 0) {
      return;
    }
    if (envLoadedSecretRef.current === selectedSecretRef) {
      return;
    }
    envLoadedSecretRef.current = selectedSecretRef;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadSavedCredential(selectedSecretRef);
        if (!cancelled) {
          const nextEnv = loaded?.env ?? [];
          setEnvVars(nextEnv);
          loadedEnvSnapshotRef.current = JSON.stringify(nextEnv);
        }
      } catch {
        if (!cancelled) {
          setEnvVars([]);
          loadedEnvSnapshotRef.current = JSON.stringify([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, sshDraft, credentialMode, selectedSecretRef]);

  // 환경변수도 자동저장하지 않는다 — submit()에서 명시적으로 저장할 때 시크릿 번들에 함께 반영한다.

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
      setSerialPortsError(error instanceof Error ? error.message : '시리얼 포트 목록을 불러오지 못했습니다.');
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
        setAwsProfilesError(error instanceof Error ? error.message : 'AWS 프로필을 불러오지 못했습니다.');
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
        return false;
      }

      const submission = buildHostFormSubmission({
        draft: nextDraft,
        tags: nextTagTokens,
        credentialMode,
        selectedSecretRef,
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
    [
      credentialMode,
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
    saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? "Couldn't save changes" : null;
  const metadataFields = (
    <>
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>Group</span>
        <SelectField value={draft.groupName ?? ''} onChange={(event) => setDraft({ ...draft, groupName: event.target.value || '' })}>
          {groupOptions.map((option) => (
            <option key={option.value ?? 'ungrouped'} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </label>
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>Tags</span>
        <TagInputField
          id="host-tag-input"
          aria-label="Tags"
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
      <span className={fieldLabelClassName}>Startup command</span>
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
            {mode === 'none' ? 'None' : mode === 'command' ? 'Command' : 'Snippet'}
          </Button>
        ))}
      </div>
      {startupCommand?.type === 'command' ? (
        <div className="flex flex-col gap-[0.4rem]">
          <Textarea
            aria-label="Startup command"
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
            연결 직후 명령과 Enter를 자동으로 전송합니다.
          </span>
        </div>
      ) : null}
      {startupCommand?.type === 'snippet' ? (
        <div className="flex flex-col gap-[0.4rem]">
          <SearchableSelect
            ariaLabel="Startup snippet"
            placeholder="Snippet 선택"
            searchPlaceholder="이름, 키워드, 명령 검색"
            emptyText="사용 가능한 Snippet이 없습니다."
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
              선택한 Snippet을 찾을 수 없습니다. 연결 시 Startup Command를 건너뜁니다.
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
    if (!isSshHostDraft(draft)) {
      await onSubmit({
        ...draft,
        tags: nextTags
      });
      return true;
    }

    const nextDraft: HostDraft = {
      ...draft,
      tags: nextTags,
      secretRef: credentialMode === 'existing' ? selectedSecretRef || null : null
    };
    await onSubmit(
      nextDraft,
      credentialMode === 'new'
        ? {
            password: password || undefined,
            passphrase: passphrase || undefined,
            privateKeyPem: privateKeyFile?.content,
            certificateText: certificateFile?.content
          }
        : undefined
    );
    return true;
  }, [
    credentialMode,
    draft,
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
    setLabel: (label: string) => setDraft((prev) => ({ ...prev, label }))
  }), [submit, submitAndConnect, submitCreate]);

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
      {hideTitle ? null : <div className="section-title">Host Editor</div>}
      {sshDraft || serialDraft || isAwsEc2Draft || isAwsEcsDraft ? null : metadataFields}

      {isAwsEc2Draft ? (
        <>
          <FormSection
            title="Connection"
            description="Required to connect."
            testId="hostform-section-connection"
          >
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>AWS Profile</span>
            <SelectField
              aria-label="AWS Profile"
              value={selectedAwsProfileValue}
              onChange={(event) => handleAwsProfileChange(event.target.value)}
              disabled={isLoadingAwsProfiles || awsProfileOptions.length === 0}
            >
              {awsProfileOptions.map((profile) => (
                <option key={profile.value} value={profile.value} disabled={profile.isMissingCurrent}>
                  {profile.isMissingCurrent ? `${profile.profileName} (앱 프로필 없음)` : profile.profileName}
                </option>
              ))}
            </SelectField>
            {awsProfilesError ? (
              <span className="text-[0.82rem] text-[var(--danger-text)]">{awsProfilesError}</span>
            ) : null}
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Region</span>
            <Input value={draft.awsRegion} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Availability Zone</span>
            <Input value={draft.awsAvailabilityZone ?? ''} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Instance ID</span>
            <Input value={draft.awsInstanceId} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Instance Name</span>
            <Input value={draft.awsInstanceName ?? ''} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Platform</span>
            <Input value={draft.awsPlatform ?? ''} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Private IP</span>
            <Input value={draft.awsPrivateIp ?? ''} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>State</span>
            <Input value={draft.awsState ?? ''} readOnly />
          </label>
          <div className="flex flex-col gap-[0.4rem] rounded-[10px] border border-[color-mix(in_srgb,var(--accent-strong)_18%,var(--border)_82%)] bg-[color-mix(in_srgb,var(--surface-elevated)_76%,var(--surface)_24%)] px-[0.9rem] py-[0.9rem]">
            <strong>{getAwsEc2HostSshMetadataStatusLabel(draft.awsSshMetadataStatus) ?? 'SSH 설정 대기 중'}</strong>
            <span className="text-[var(--text-soft)] leading-[1.5]">
              {draft.awsSshMetadataError
                ? draft.awsSshMetadataError
                : draft.awsSshMetadataStatus === 'loading'
                  ? '추가 정보 로드가 끝나면 SSH 사용자와 포트를 자동으로 채웁니다.'
                  : '필요하면 아래 값만 수동으로 수정하면 됩니다.'}
            </span>
          </div>
          <div className="grid gap-[0.7rem] md:grid-cols-[120px_minmax(0,1fr)]">
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>SSH Port</span>
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
              <span className={fieldLabelClassName}>SSH Username</span>
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
              label="서버 프록시 사용"
              description="활성화 시 서버가 AWS SSM 세션을 열고 터미널 입출력만 전달합니다."
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
              label="SSH Agent Forwarding"
              description="로컬 SSH 키를 원격에서 쓸 수 있게 합니다(예: bastion에서 사설 호스트로 hop). 신뢰하는 호스트만 켜세요."
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
            title="Details"
            description="How this host appears in the app."
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title="Preferences"
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
            title="Connection"
            description="Required to connect."
            testId="hostform-section-connection"
          >
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>AWS Profile</span>
            <SelectField
              aria-label="AWS Profile"
              value={selectedAwsProfileValue}
              onChange={(event) => handleAwsProfileChange(event.target.value)}
              disabled={isLoadingAwsProfiles || awsProfileOptions.length === 0}
            >
              {awsProfileOptions.map((profile) => (
                <option key={profile.value} value={profile.value} disabled={profile.isMissingCurrent}>
                  {profile.isMissingCurrent ? `${profile.profileName} (앱 프로필 없음)` : profile.profileName}
                </option>
              ))}
            </SelectField>
            {awsProfilesError ? (
              <span className="text-[0.82rem] text-[var(--danger-text)]">{awsProfilesError}</span>
            ) : null}
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Region</span>
            <Input value={draft.awsRegion} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>ECS Cluster</span>
            <Input value={draft.awsEcsClusterName} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Cluster ARN</span>
            <Input value={draft.awsEcsClusterArn} readOnly />
          </label>
          </FormSection>

          <FormSection
            title="Details"
            description="How this host appears in the app."
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title="Preferences"
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
            <span className={fieldLabelClassName}>Warpgate URL</span>
            <Input value={draft.warpgateBaseUrl} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Warpgate SSH Endpoint</span>
            <Input value={`${draft.warpgateSshHost}:${draft.warpgateSshPort}`} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Target</span>
            <Input value={draft.warpgateTargetName} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Target ID</span>
            <Input value={draft.warpgateTargetId} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Warpgate Username</span>
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
            title="Connection"
            description="Required to connect."
            testId="hostform-section-connection"
          >
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>Hostname</span>
              <Input
                value={sshDraft.hostname}
                onChange={(event) => handleSshHostnameChange(event.target.value)}
                placeholder="prod.example.com"
                required
              />
            </label>
            <div className="grid gap-[0.7rem] md:grid-cols-[120px_minmax(0,1fr)]">
              <label className={fieldClassName}>
                <span className={fieldLabelClassName}>Port</span>
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
                <span className={fieldLabelClassName}>Username</span>
                <Input
                  aria-label="Username"
                  value={sshDraft.username}
                  onChange={(event) => setDraft({ ...sshDraft, username: event.target.value })}
                  placeholder="ubuntu"
                />
              </label>
            </div>
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>Auth Type</span>
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
                <option value="password">Password</option>
                <option value="privateKey">Private key</option>
                <option value="certificate">Certificate</option>
                <option value="agent">SSH Agent</option>
              </SelectField>
            </label>

            {sshDraft.authType === 'agent' ? (
              <div className="grid gap-[0.45rem]">
                <p className="text-[0.8rem] leading-[1.5] text-[var(--text-soft)]">
                  키 파일이나 비밀번호 없이, 이 컴퓨터의 SSH 에이전트로 인증합니다.
                  1Password나 ssh-add로 등록해 둔 키가 자동으로 사용됩니다.
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
                <span className={fieldLabelClassName}>Password</span>
                <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={host ? 'Leave blank to keep' : ''} />
              </label>
            ) : null}

            {credentialMode === 'new' && (sshDraft.authType === 'privateKey' || sshDraft.authType === 'certificate') ? (
              <>
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>Private key file</span>
                  <div className="flex gap-[0.7rem]">
                    <Input
                      readOnly
                      value={privateKeyFile?.name ?? ''}
                      placeholder="/Users/.../.ssh/id_ed25519"
                    />
                    <Button variant="secondary" onClick={pickPrivateKey}>
                      Import
                    </Button>
                  </div>
                </label>
                {sshDraft.authType === 'certificate' ? (
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>SSH certificate file</span>
                    <div className="flex gap-[0.7rem]">
                      <Input
                        readOnly
                        value={certificateFile?.name ?? ''}
                        placeholder="/Users/.../.ssh/id_ed25519-cert.pub"
                      />
                      <Button variant="secondary" onClick={pickCertificate}>
                        Import
                      </Button>
                    </div>
                  </label>
                ) : null}
                {credentialMode === 'new' ? (
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>Passphrase</span>
                    <Input
                      type="password"
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      placeholder={host ? 'Leave blank to keep' : ''}
                    />
                  </label>
                ) : null}
              </>
            ) : null}

            {sshDraft.authType !== 'agent' ? (
            <div className="grid gap-[0.55rem]">
              <div className="flex items-center justify-between gap-3">
                <span className={fieldLabelClassName}>Saved Credentials</span>
                {onOpenSecrets && keychainEntries.length > 0 ? (
                  <button
                    type="button"
                    className="border-0 bg-transparent p-0 text-[0.9rem] font-semibold text-[var(--accent-strong)]"
                    onClick={onOpenSecrets}
                  >
                    Manage
                  </button>
                ) : null}
              </div>
              <SelectField
                aria-label="Saved Credentials"
                value={credentialMode === 'existing' ? `existing:${selectedSecretRef}` : credentialMode}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'new') {
                    setCredentialMode('new');
                    setSelectedSecretRef('');
                    return;
                  }
                  if (value.startsWith('existing:')) {
                    setCredentialMode('existing');
                    setSelectedSecretRef(value.slice('existing:'.length));
                  }
                }}
              >
                <option value="new">새 인증 정보 저장</option>
                {reusableEntries.map((entry) => (
                  <option key={entry.secretRef} value={`existing:${entry.secretRef}`}>
                    {formatSavedSecretOptionLabel(entry)}
                  </option>
                ))}
              </SelectField>
            </div>
            ) : null}

            {credentialMode === 'existing' && sshDraft.authType !== 'agent' ? (
              <div className="grid gap-[0.55rem]">
                {host && isSshHostRecord(host) && selectedSecretRef && onEditExistingSecret ? (
                  <Button
                    variant="secondary"
                    onClick={() => onEditExistingSecret(selectedSecretRef)}
                  >
                    편집
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className={fieldClassName}>
              <span className={fieldLabelClassName}>Jump hosts</span>
              <JumpHostChainEditor
                value={jumpHostChain}
                candidates={jumpHostOptions}
                disabled={sshDraft.useMosh === true && jumpHostChain.length === 0}
                onChange={commitJumpHostChain}
              />
              <span className="text-[0.82rem] text-[var(--text-soft)]">
                다른 SSH 호스트를 거쳐 연결합니다 (배스천). 여러 개면 위에서부터 순서대로 거칩니다
                — 첫 번째가 클라이언트에서 직접 연결, 마지막이 대상 바로 앞입니다.
              </span>
            </div>
            <div className={fieldClassName}>
              <ToggleSwitch
                label="Mosh로 연결"
                description={
                  jumpHostChain.length > 0
                    ? 'jump host와 함께 쓸 수 없습니다.'
                    : '네트워크가 끊겨도 세션이 유지됩니다 (서버에 mosh 필요).'
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
                label="SSH Agent Forwarding"
                description={
                  sshDraft.useMosh === true
                    ? 'mosh 세션에서는 지원하지 않습니다.'
                    : '로컬 SSH 키를 원격에서 쓸 수 있게 합니다. 신뢰하는 호스트만 켜세요.'
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
            title="Details"
            description="How this host appears in the app."
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title="Preferences"
            description="Optional local preference."
            testId="hostform-section-preferences"
          >
            {renderTerminalThemeField(sshDraft.terminalThemeId ?? null, (terminalThemeId) => setDraft({ ...sshDraft, terminalThemeId }))}
            {startupCommandField}
            <div className={fieldClassName}>
              <span className={fieldLabelClassName}>Environment Variables</span>
              <EnvironmentVariablesEditor
                variables={envVars}
                onChange={setEnvVars}
              />
              <span className="text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                연결 시 셸에 주입됩니다(SetEnv→export 폴백). 값은 비밀번호처럼 암호화되어 저장·동기화됩니다.
              </span>
            </div>
          </FormSection>
        </>
      ) : serialDraft ? (
        <>
          <FormSection
            title="Connection"
            description="Configure the serial transport and terminal behavior."
            testId="hostform-section-connection"
          >
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>Transport</span>
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
                <option value="local">Local serial port</option>
                <option value="raw-tcp">Raw TCP</option>
                <option value="rfc2217">RFC2217</option>
              </SelectField>
            </label>

            {serialDraft.transport === 'local' ? (
              <>
                <div className="grid gap-[0.55rem]">
                  <div className="flex items-center justify-between gap-3">
                    <span className={fieldLabelClassName}>Detected Ports</span>
                    <Button variant="secondary" onClick={() => void refreshSerialPorts()}>
                      Refresh
                    </Button>
                  </div>
                  <SelectField
                    aria-label="Detected Serial Port"
                    value={
                      serialPorts.some((port) => port.path === (serialDraft.devicePath ?? ''))
                        ? serialDraft.devicePath ?? ''
                        : ''
                    }
                    onChange={(event) => handleSerialFieldChange('devicePath', event.target.value)}
                  >
                    <option value="">Select detected port</option>
                    {serialPorts.map((port) => (
                      <option key={port.path} value={port.path}>
                        {port.displayName}
                      </option>
                    ))}
                  </SelectField>
                  {serialPortsError ? (
                    <span className="text-[0.82rem] text-[var(--danger-text)]">{serialPortsError}</span>
                  ) : isLoadingSerialPorts ? (
                    <span className="text-[0.82rem] text-[var(--text-soft)]">Loading serial ports...</span>
                  ) : null}
                </div>
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>Device Path</span>
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
                  <span className={fieldLabelClassName}>Remote Host</span>
                  <Input
                    value={serialDraft.host ?? ''}
                    onChange={(event) => handleSerialFieldChange('host', event.target.value)}
                    placeholder="serial-gateway.local"
                    required
                  />
                </label>
                <label className={fieldClassName}>
                  <span className={fieldLabelClassName}>Port</span>
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
                    <span className={fieldLabelClassName}>Baud Rate</span>
                    <Input
                      type="number"
                      min={1}
                      value={serialDraft.baudRate}
                      onChange={(event) => handleSerialFieldChange('baudRate', Number(event.target.value) || 115200)}
                      required
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>Data Bits</span>
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
                    <span className={fieldLabelClassName}>Parity</span>
                    <SelectField
                      value={serialDraft.parity}
                      onChange={(event) => handleSerialFieldChange('parity', event.target.value as SerialHostDraft['parity'])}
                    >
                      <option value="none">None</option>
                      <option value="odd">Odd</option>
                      <option value="even">Even</option>
                      <option value="mark">Mark</option>
                      <option value="space">Space</option>
                    </SelectField>
                  </label>
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>Stop Bits</span>
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
                  <span className={fieldLabelClassName}>Flow Control</span>
                  <SelectField
                    value={serialDraft.flowControl}
                    onChange={(event) => handleSerialFieldChange('flowControl', event.target.value as SerialHostDraft['flowControl'])}
                  >
                    <option value="none">None</option>
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
                label="Local Echo"
                description="Echo typed characters locally."
                onClick={() => handleSerialFieldChange('localEcho', !serialDraft.localEcho)}
              />
              <ToggleSwitch
                checked={serialDraft.localLineEditing}
                label="Local Line Editing"
                description="Handle backspace and basic line editing locally."
                onClick={() => handleSerialFieldChange('localLineEditing', !serialDraft.localLineEditing)}
              />
            </div>
          </FormSection>

          <FormSection
            title="Details"
            description="How this host appears in the app."
            testId="hostform-section-details"
          >
            {metadataFields}
          </FormSection>

          <FormSection
            title="Preferences"
            description="Optional local preference."
            testId="hostform-section-preferences"
          >
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>Line Ending</span>
              <SelectField
                aria-label="Line Ending"
                value={serialDraft.transmitLineEnding}
                onChange={(event) =>
                  handleSerialFieldChange(
                    'transmitLineEnding',
                    event.target.value as SerialHostDraft['transmitLineEnding'],
                  )
                }
              >
                <option value="none">None</option>
                <option value="cr">CR</option>
                <option value="lf">LF</option>
                <option value="crlf">CRLF</option>
              </SelectField>
            </label>
            {renderTerminalThemeField(serialDraft.terminalThemeId ?? null, (terminalThemeId) => setDraft({ ...serialDraft, terminalThemeId }))}
          </FormSection>
        </>
      ) : null}

    </form>
    </>
  );
});
