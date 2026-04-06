import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAwsEc2HostSshMetadataStatusLabel, isAwsEc2HostRecord, isAwsEcsHostRecord, isSshHostDraft, isSshHostRecord, isWarpgateSshHostRecord } from '@shared';
import type { HostDraft, HostRecord, SecretMetadataRecord, TerminalThemeId } from '@shared';
import { useHostFormController } from '../controllers/useHostFormController';
import { cn } from '../lib/cn';
import { terminalThemePresets } from '../lib/terminal-presets';
import { Button } from '../ui';

const defaultDraft: HostDraft = {
  kind: 'ssh',
  label: '',
  tags: [],
  hostname: '',
  port: 22,
  username: '',
  authType: 'password',
  privateKeyPath: '',
  secretRef: null,
  groupName: '',
  terminalThemeId: null
};

function createDraft(defaultGroupPath?: string | null): HostDraft {
  return {
    ...defaultDraft,
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

interface HostFormProps {
  host: HostRecord | null;
  keychainEntries: SecretMetadataRecord[];
  groupOptions: Array<{ value: string | null; label: string }>;
  defaultGroupPath?: string | null;
  hideTitle?: boolean;
  onSubmit: (draft: HostDraft, secrets?: { password?: string; passphrase?: string }) => Promise<void>;
  onConnect?: (hostId: string) => Promise<void>;
  onDelete?: () => Promise<void>;
  onEditExistingSecret?: (secretRef: string, credentialKind: 'password' | 'passphrase') => void;
  onOpenSecrets?: () => void;
}

type HostFormSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface HostFormSubmission {
  draft: HostDraft;
  secrets?: {
    password?: string;
    passphrase?: string;
  };
}

function isHostDraftValid(draft: HostDraft): boolean {
  if (!draft.label.trim()) {
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

  if (draft.kind === 'warpgate-ssh') {
    return Boolean(draft.warpgateUsername.trim());
  }

  return true;
}

function buildHostFormSubmission(input: {
  draft: HostDraft;
  tags: string[];
  credentialMode: 'new' | 'existing' | 'none';
  selectedSecretRef: string;
  password: string;
  passphrase: string;
}): HostFormSubmission {
  const nextTags = dedupeTags(input.tags);
  if (!isSshHostDraft(input.draft)) {
    return {
      draft: {
        ...input.draft,
        tags: nextTags
      }
    };
  }

  const nextDraft: HostDraft = {
    ...input.draft,
    tags: nextTags,
    secretRef: input.credentialMode === 'existing' ? input.selectedSecretRef || null : null
  };

  if (input.credentialMode !== 'new') {
    return {
      draft: nextDraft
    };
  }

  const nextSecrets = {
    password: input.password || undefined,
    passphrase: input.passphrase || undefined
  };

  return {
    draft: nextDraft,
    secrets: nextSecrets.password || nextSecrets.passphrase ? nextSecrets : undefined
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
    <label className="flex flex-col gap-[0.45rem] text-[var(--text)]">
      <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
        Terminal Theme
      </span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? (event.target.value as TerminalThemeId) : null)}
      >
        <option value="">Use global theme</option>
        {terminalThemePresets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.title}
          </option>
        ))}
      </select>
    </label>
  );
}

export function HostForm({
  host,
  keychainEntries,
  groupOptions,
  defaultGroupPath = null,
  hideTitle = false,
  onSubmit,
  onConnect,
  onDelete,
  onEditExistingSecret,
  onOpenSecrets
}: HostFormProps) {
  const fieldClassName = 'flex flex-col gap-[0.45rem] text-[var(--text)]';
  const fieldLabelClassName =
    'text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]';
  const { pickPrivateKey: pickPrivateKeyFile } = useHostFormController();
  const formRef = useRef<HTMLFormElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const lastHydratedHostIdRef = useRef<string | null>(null);
  const lastHydratedHostKeyRef = useRef<string | null>(null);
  const isTagInputComposingRef = useRef(false);
  const skipNextTagBlurCommitRef = useRef(false);
  const [draft, setDraft] = useState<HostDraft>(createDraft(defaultGroupPath));
  const [tagTokens, setTagTokens] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [credentialMode, setCredentialMode] = useState<'new' | 'existing' | 'none'>('new');
  const [selectedSecretRef, setSelectedSecretRef] = useState('');
  const [saveStatus, setSaveStatus] = useState<HostFormSaveStatus>('idle');
  const [lastSavedSubmissionKey, setLastSavedSubmissionKey] = useState<string | null>(null);
  const [saveInFlight, setSaveInFlight] = useState(false);

  const isEditMode = Boolean(host);

  const sshDraft = isSshHostDraft(draft) ? draft : null;
  const currentSubmission = useMemo(
    () =>
      buildHostFormSubmission({
        draft,
        tags: tagTokens,
        credentialMode,
        selectedSecretRef,
        password,
        passphrase
      }),
    [credentialMode, draft, passphrase, password, selectedSecretRef, tagTokens]
  );
  const currentSubmissionKey = useMemo(() => serializeHostFormSubmission(currentSubmission), [currentSubmission]);
  const isEditDirty = isEditMode && currentSubmissionKey !== lastSavedSubmissionKey;
  const reusableEntries = useMemo(() => {
    if (!sshDraft) {
      return [];
    }
    return keychainEntries.filter((entry) =>
      sshDraft.authType === 'password' ? entry.hasPassword : entry.hasManagedPrivateKey || entry.hasPassphrase
    );
  }, [keychainEntries, sshDraft]);

  useEffect(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (!host) {
      setDraft(createDraft(defaultGroupPath));
      setPassword('');
      setPassphrase('');
      setSelectedSecretRef('');
      setCredentialMode('new');
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
    let nextCredentialMode: 'new' | 'existing' | 'none';
    let nextSelectedSecretRef = '';
    let nextPassword = '';
    let nextPassphrase = '';

    if (isAwsEc2HostRecord(host)) {
      nextDraft = {
        kind: 'aws-ec2',
        label: host.label,
        tags: host.tags ?? [],
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
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
        awsSshMetadataError: host.awsSshMetadataError ?? null
      };
      nextCredentialMode = 'none';
    } else if (isAwsEcsHostRecord(host)) {
      nextDraft = {
        kind: 'aws-ecs',
        label: host.label,
        tags: host.tags ?? [],
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null,
        awsProfileName: host.awsProfileName,
        awsRegion: host.awsRegion,
        awsEcsClusterArn: host.awsEcsClusterArn,
        awsEcsClusterName: host.awsEcsClusterName
      };
      nextCredentialMode = 'none';
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
        warpgateUsername: host.warpgateUsername
      };
      nextCredentialMode = 'none';
    } else {
      nextDraft = {
        kind: 'ssh',
        label: host.label,
        tags: host.tags ?? [],
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        authType: host.authType,
        privateKeyPath: host.privateKeyPath ?? '',
        secretRef: host.secretRef,
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null
      };
      nextSelectedSecretRef = host.secretRef ?? '';
      nextCredentialMode = host.secretRef ? 'existing' : host.authType === 'password' ? 'new' : 'none';
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
    setTagTokens(nextTagTokens);
    setTagInput('');
    setSaveStatus('idle');
    setSaveInFlight(false);
    setLastSavedSubmissionKey(nextSubmissionKey);
    lastHydratedHostIdRef.current = host.id;
    lastHydratedHostKeyRef.current = nextHydrationKey;
  }, [defaultGroupPath, host, isEditDirty, saveInFlight]);

  useEffect(() => {
    if (!sshDraft) {
      return;
    }

    if (sshDraft.authType === 'password' && credentialMode === 'none') {
      setCredentialMode('new');
    }

    if (credentialMode === 'existing' && selectedSecretRef && !reusableEntries.some((entry) => entry.secretRef === selectedSecretRef)) {
      setSelectedSecretRef('');
      setCredentialMode(sshDraft.authType === 'password' ? 'new' : 'none');
    }
  }, [credentialMode, reusableEntries, selectedSecretRef, sshDraft]);

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
    setDraft((current) => (isSshHostDraft(current) ? { ...current, privateKeyPath: selected } : current));
  }

  function updateDraftTags(nextTags: string[]) {
    setTagTokens(nextTags);
    setDraft((current) => ({
      ...current,
      tags: nextTags
    }));
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
      const browserValidity = formRef.current?.checkValidity();
      if (typeof browserValidity === 'boolean') {
        return browserValidity && isHostDraftValid(nextDraft);
      }
      return isHostDraftValid(nextDraft);
    },
    []
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
        passphrase
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
      host,
      isEditMode,
      isFormValid,
      lastSavedSubmissionKey,
      onSubmit,
      passphrase,
      password,
      selectedSecretRef,
      tagInput,
      tagTokens
    ]
  );

  useEffect(() => {
    if (!isEditMode || saveInFlight || !isEditDirty || !isFormValid(draft)) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistChanges({ commitPendingTag: false }).catch(() => undefined);
    }, 800);

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [draft, isEditDirty, isEditMode, isFormValid, persistChanges, saveInFlight]);

  const isAwsDraft = draft.kind === 'aws-ec2';
  const isAwsEcsDraft = draft.kind === 'aws-ecs';
  const saveStatusText =
    saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? "Couldn't save changes" : null;

  return (
    <form
      ref={formRef}
      className="flex flex-col gap-[0.95rem]"
      onSubmit={async (event) => {
        event.preventDefault();
        if (isEditMode) {
          return;
        }
        const nextTags = appendPendingTag(tagTokens, tagInput);
        if (!isSshHostDraft(draft)) {
          await onSubmit({
            ...draft,
            tags: nextTags
          });
          return;
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
                passphrase: passphrase || undefined
              }
            : undefined
        );
      }}
    >
      {hideTitle ? null : <div className="section-title">Host Editor</div>}
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>Label</span>
        <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Production API" required />
      </label>
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>Group</span>
        <select value={draft.groupName ?? ''} onChange={(event) => setDraft({ ...draft, groupName: event.target.value || '' })}>
          {groupOptions.map((option) => (
            <option key={option.value ?? 'ungrouped'} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>Tags</span>
        <div
          className="flex min-h-[3.5rem] flex-wrap items-center gap-[0.55rem] rounded-[14px] border border-[var(--border)] bg-[var(--surface-strong)] px-[0.95rem] py-[0.78rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
          onClick={() => document.getElementById('host-tag-input')?.focus()}
        >
          {tagTokens.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-[0.35rem] rounded-full border border-[color-mix(in_srgb,var(--accent-strong)_24%,var(--border)_76%)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,var(--surface-strong))] px-[0.62rem] py-[0.36rem] text-[var(--text)]"
            >
              <span>{tag}</span>
              <button
                type="button"
                className="inline-grid h-[1.1rem] w-[1.1rem] place-items-center rounded-full text-[var(--text-soft)]"
                aria-label={`${tag} 태그 제거`}
                onClick={() => removeTag(tag)}
              >
                ×
              </button>
            </span>
          ))}
          <input
            id="host-tag-input"
            className="min-w-[9rem] flex-1 border-none bg-transparent p-0 shadow-none focus:outline-none"
            value={tagInput}
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
        </div>
      </label>

      {isAwsDraft ? (
        <>
          {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}

          <label>
            AWS Profile
            <input value={draft.awsProfileName} readOnly />
          </label>
          <label>
            Region
            <input value={draft.awsRegion} readOnly />
          </label>
          <label>
            Availability Zone
            <input value={draft.awsAvailabilityZone ?? ''} readOnly />
          </label>
          <label>
            Instance ID
            <input value={draft.awsInstanceId} readOnly />
          </label>
          <label>
            Instance Name
            <input value={draft.awsInstanceName ?? ''} readOnly />
          </label>
          <label>
            Platform
            <input value={draft.awsPlatform ?? ''} readOnly />
          </label>
          <label>
            Private IP
            <input value={draft.awsPrivateIp ?? ''} readOnly />
          </label>
          <label>
            State
            <input value={draft.awsState ?? ''} readOnly />
          </label>
          <div className="flex flex-col gap-[0.35rem] rounded-[14px] border border-[color-mix(in_srgb,var(--accent-strong)_18%,var(--border)_82%)] bg-[color-mix(in_srgb,var(--surface-elevated)_76%,var(--surface)_24%)] px-[0.95rem] py-[0.85rem]">
            <strong>{getAwsEc2HostSshMetadataStatusLabel(draft.awsSshMetadataStatus) ?? 'SSH 설정 대기 중'}</strong>
            <span className="text-[var(--text-soft)] leading-[1.5]">
              {draft.awsSshMetadataError
                ? draft.awsSshMetadataError
                : draft.awsSshMetadataStatus === 'loading'
                  ? '추가 정보 로드가 끝나면 SSH 사용자와 포트를 자동으로 채웁니다.'
                  : '필요하면 아래 값만 수동으로 수정하면 됩니다.'}
            </span>
          </div>
          <div className="grid gap-[0.75rem] md:grid-cols-[120px_minmax(0,1fr)]">
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>SSH Port</span>
              <input
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
              <input
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
        </>
      ) : isAwsEcsDraft ? (
        <>
          {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}

          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>AWS Profile</span>
            <input value={draft.awsProfileName} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Region</span>
            <input value={draft.awsRegion} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>ECS Cluster</span>
            <input value={draft.awsEcsClusterName} readOnly />
          </label>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Cluster ARN</span>
            <input value={draft.awsEcsClusterArn} readOnly />
          </label>
        </>
      ) : draft.kind === 'warpgate-ssh' ? (
        <>
          {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}

          <label>
            Warpgate URL
            <input value={draft.warpgateBaseUrl} readOnly />
          </label>
          <label>
            Warpgate SSH Endpoint
            <input value={`${draft.warpgateSshHost}:${draft.warpgateSshPort}`} readOnly />
          </label>
          <label>
            Target
            <input value={draft.warpgateTargetName} readOnly />
          </label>
          <label>
            Target ID
            <input value={draft.warpgateTargetId} readOnly />
          </label>
          <label>
            Warpgate Username
            <input
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
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Hostname</span>
            <input
              value={sshDraft.hostname}
              onChange={(event) => setDraft({ ...sshDraft, hostname: event.target.value })}
              placeholder="prod.example.com"
              required
            />
          </label>
          <div className="grid gap-[0.75rem] md:grid-cols-[120px_minmax(0,1fr)]">
            <label className={fieldClassName}>
              <span className={fieldLabelClassName}>Port</span>
              <input
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
              <input
                value={sshDraft.username}
                onChange={(event) => setDraft({ ...sshDraft, username: event.target.value })}
                placeholder="ubuntu"
              />
            </label>
          </div>
          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>Auth Type</span>
            <select
              value={sshDraft.authType}
              onChange={(event) =>
                setDraft({
                  ...sshDraft,
                  authType: event.target.value === 'privateKey' ? 'privateKey' : 'password'
                })
              }
            >
              <option value="password">Password</option>
              <option value="privateKey">Private key</option>
            </select>
          </label>

          {renderTerminalThemeField(sshDraft.terminalThemeId ?? null, (terminalThemeId) => setDraft({ ...sshDraft, terminalThemeId }))}

          <label>
            Secret
            <select
              value={credentialMode === 'existing' ? `existing:${selectedSecretRef}` : credentialMode}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'new' || value === 'none') {
                  setCredentialMode(value);
                  setSelectedSecretRef('');
                  return;
                }
                if (value.startsWith('existing:')) {
                  setCredentialMode('existing');
                  setSelectedSecretRef(value.slice('existing:'.length));
                }
              }}
            >
              {sshDraft.authType === 'privateKey' ? <option value="none">사용 안 함</option> : null}
              <option value="new">새 secret 생성</option>
              {reusableEntries.map((entry) => (
                <option key={entry.secretRef} value={`existing:${entry.secretRef}`}>
                  {entry.label} ({entry.linkedHostCount}개 호스트)
                </option>
              ))}
            </select>
          </label>

          {onOpenSecrets && keychainEntries.length > 0 ? (
            <button
              type="button"
              className="mt-[-0.2rem] self-start border-0 bg-transparent p-0 text-[0.88rem] font-semibold text-[var(--accent-strong)]"
              onClick={onOpenSecrets}
            >
              Secrets 열기
            </button>
          ) : null}

          {sshDraft.authType === 'password' && credentialMode === 'new' ? (
            <label>
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={host ? 'Leave blank to keep' : ''} />
            </label>
          ) : null}

          {credentialMode === 'existing' ? (
            <>
              <p className="mt-[-0.1rem] text-[var(--text-soft)] leading-[1.5]">선택한 secret을 이 호스트와 공유합니다. 이 호스트를 삭제해도 secret 항목은 유지됩니다.</p>
              {host && isSshHostRecord(host) && selectedSecretRef && host.secretRef === selectedSecretRef && onEditExistingSecret ? (
                <Button
                  variant="secondary"
                  onClick={() => onEditExistingSecret(selectedSecretRef, sshDraft.authType === 'password' ? 'password' : 'passphrase')}
                >
                  {sshDraft.authType === 'password' ? '비밀번호 변경' : 'Passphrase 변경'}
                </Button>
              ) : null}
            </>
          ) : null}

          {sshDraft.authType === 'privateKey' ? (
            <>
              <label>
                Private key file
                <div className="flex gap-[0.75rem]">
                  <input
                    value={sshDraft.privateKeyPath ?? ''}
                    onChange={(event) => setDraft({ ...sshDraft, privateKeyPath: event.target.value })}
                    placeholder="/Users/.../.ssh/id_ed25519"
                  />
                  <Button variant="secondary" onClick={pickPrivateKey}>
                    Import
                  </Button>
                </div>
              </label>
              {credentialMode === 'new' ? (
                <label>
                  Passphrase
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    placeholder={host ? 'Leave blank to keep' : ''}
                  />
                </label>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      <div className="mt-[0.8rem] flex gap-[0.75rem]">
        {isEditMode ? (
          <Button
            variant="primary"
            className="flex-1 rounded-[16px] border border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] bg-[color-mix(in_srgb,var(--surface-elevated)_90%,var(--accent-strong)_10%)] px-[1.1rem] py-[0.95rem] font-[650] text-[var(--text)] shadow-none transition-[border-color,background-color,color] duration-160 hover:border-[color-mix(in_srgb,var(--accent-strong)_40%,var(--border)_60%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_84%,var(--accent-strong)_16%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_60%,white_40%)] focus-visible:ring-offset-2"
            onClick={async () => {
              if (!host || !onConnect) {
                return;
              }

              if (!isFormValid(draft)) {
                formRef.current?.reportValidity();
                return;
              }

              const didSave = await persistChanges({ commitPendingTag: true }).catch(() => false);
              if (!didSave) {
                return;
              }

              await onConnect(host.id);
            }}
            disabled={saveInFlight}
          >
            Connect
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            className="flex-1 rounded-[16px] border border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] bg-[color-mix(in_srgb,var(--surface-elevated)_90%,var(--accent-strong)_10%)] px-[1.1rem] py-[0.95rem] font-[650] text-[var(--text)] shadow-none transition-[border-color,background-color,color] duration-160 hover:border-[color-mix(in_srgb,var(--accent-strong)_40%,var(--border)_60%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_84%,var(--accent-strong)_16%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_60%,white_40%)] focus-visible:ring-offset-2"
          >
            Create Host
          </Button>
        )}
        {host && onDelete ? (
          <Button
            variant="danger"
            onClick={async () => {
              await onDelete();
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>
      {isEditMode && saveStatusText ? (
        <div
          className={cn(
            'mt-[0.1rem] text-[0.86rem] leading-[1.4] text-[var(--text-soft)]',
            saveStatus === 'error' && 'text-[color-mix(in_srgb,var(--danger)_82%,white_18%)]',
          )}
        >
          {saveStatusText}
        </div>
      ) : null}
    </form>
  );
}
