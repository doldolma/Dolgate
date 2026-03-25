import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAwsEc2HostRecord, isSshHostDraft, isSshHostRecord, isWarpgateSshHostRecord } from '@shared';
import type { HostDraft, HostRecord, SecretMetadataRecord, TerminalThemeId } from '@shared';
import { terminalThemePresets } from '../lib/terminal-presets';

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

  if (draft.kind === 'ssh') {
    return Boolean(draft.hostname.trim()) && Boolean(draft.username.trim()) && Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535;
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

function renderTerminalThemeField(
  value: TerminalThemeId | null | undefined,
  onChange: (value: TerminalThemeId | null) => void
) {
  return (
    <label>
      Terminal Theme
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
  const formRef = useRef<HTMLFormElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const lastHydratedHostIdRef = useRef<string | null>(null);
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
      return;
    }

    const shouldRehydrate = lastHydratedHostIdRef.current !== host.id || (!isEditDirty && !saveInFlight);
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
        awsInstanceName: host.awsInstanceName ?? null,
        awsPlatform: host.awsPlatform ?? null,
        awsPrivateIp: host.awsPrivateIp ?? null,
        awsState: host.awsState ?? null
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
    const selected = await window.dolssh.shell.pickPrivateKey();
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
  const saveStatusText =
    saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? "Couldn't save changes" : null;

  return (
    <form
      ref={formRef}
      className="host-form"
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
      <label>
        Label
        <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Production API" required />
      </label>
      <label>
        Group
        <select value={draft.groupName ?? ''} onChange={(event) => setDraft({ ...draft, groupName: event.target.value || '' })}>
          {groupOptions.map((option) => (
            <option key={option.value ?? 'ungrouped'} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Tags
        <div className="tag-token-input" onClick={() => document.getElementById('host-tag-input')?.focus()}>
          {tagTokens.map((tag) => (
            <span key={tag} className="tag-token">
              <span>{tag}</span>
              <button
                type="button"
                className="tag-token__remove"
                aria-label={`${tag} 태그 제거`}
                onClick={() => removeTag(tag)}
              >
                ×
              </button>
            </span>
          ))}
          <input
            id="host-tag-input"
            className="tag-token-input__field"
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
          <label>
            Hostname
            <input
              value={sshDraft.hostname}
              onChange={(event) => setDraft({ ...sshDraft, hostname: event.target.value })}
              placeholder="prod.example.com"
              required
            />
          </label>
          <div className="row two-col">
            <label>
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={sshDraft.port}
                onChange={(event) => setDraft({ ...sshDraft, port: Number(event.target.value) || 22 })}
                required
              />
            </label>
            <label>
              Username
              <input
                value={sshDraft.username}
                onChange={(event) => setDraft({ ...sshDraft, username: event.target.value })}
                placeholder="ubuntu"
                required
              />
            </label>
          </div>
          <label>
            Auth Type
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
            <button type="button" className="host-form__inline-action" onClick={onOpenSecrets}>
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
              <p className="form-note">선택한 secret을 이 호스트와 공유합니다. 이 호스트를 삭제해도 secret 항목은 유지됩니다.</p>
              {host && isSshHostRecord(host) && selectedSecretRef && host.secretRef === selectedSecretRef && onEditExistingSecret ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onEditExistingSecret(selectedSecretRef, sshDraft.authType === 'password' ? 'password' : 'passphrase')}
                >
                  {sshDraft.authType === 'password' ? '비밀번호 변경' : 'Passphrase 변경'}
                </button>
              ) : null}
            </>
          ) : null}

          {sshDraft.authType === 'privateKey' ? (
            <>
              <label>
                Private key file
                <div className="file-input-row">
                  <input
                    value={sshDraft.privateKeyPath ?? ''}
                    onChange={(event) => setDraft({ ...sshDraft, privateKeyPath: event.target.value })}
                    placeholder="/Users/.../.ssh/id_ed25519"
                  />
                  <button type="button" className="secondary-button" onClick={pickPrivateKey}>
                    Import
                  </button>
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

      <div className="form-actions">
        {isEditMode ? (
          <button
            type="button"
            className="host-form__submit"
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
          </button>
        ) : (
          <button type="submit" className="host-form__submit">
            Create Host
          </button>
        )}
        {host && onDelete ? (
          <button
            type="button"
            className="danger-button"
            onClick={async () => {
              await onDelete();
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
      {isEditMode && saveStatusText ? <div className={`host-form__save-status host-form__save-status--${saveStatus}`}>{saveStatusText}</div> : null}
    </form>
  );
}
