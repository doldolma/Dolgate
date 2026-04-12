import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAwsEc2HostSshMetadataStatusLabel, isAwsEc2HostRecord, isAwsEcsHostRecord, isSshHostDraft, isSshHostRecord, isWarpgateSshHostRecord } from '@shared';
import type { AwsProfileSummary, HostDraft, HostRecord, HostSecretInput, SecretMetadataRecord, SshHostDraft, TerminalThemeId } from '@shared';
import { useHostFormController } from '../controllers/useHostFormController';
import { formatSavedSecretOptionLabel } from '../lib/secret-display';
import { terminalThemePresets } from '../lib/terminal-presets';
import { listAwsProfiles } from '../services/desktop/imports';
import { Button, Input, SelectField, TagInputField } from '../ui';

const defaultDraft: HostDraft = {
  kind: 'ssh',
  label: '',
  tags: [],
  hostname: '',
  port: 22,
  username: '',
  authType: 'password',
  privateKeyPath: '',
  certificatePath: '',
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

function deriveDefaultHostLabel(draft: HostDraft): string {
  if (draft.kind === 'ssh') {
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
  submitAndConnect: () => Promise<boolean>;
}

export interface HostFormProps {
  host: HostRecord | null;
  keychainEntries: SecretMetadataRecord[];
  groupOptions: Array<{ value: string | null; label: string }>;
  defaultGroupPath?: string | null;
  hideTitle?: boolean;
  onSubmit: (draft: HostDraft, secrets?: HostSecretInput) => Promise<void>;
  onConnect?: (hostId: string) => Promise<void>;
  onEditExistingSecret?: (secretRef: string, credentialKind: 'password' | 'passphrase') => void;
  onOpenSecrets?: () => void;
  onActionStateChange?: (state: HostFormActionState) => void;
}

type HostFormSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface HostFormSubmission {
  draft: HostDraft;
  secrets?: HostSecretInput;
}

interface ImportedShellCredentialFile {
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

  if (draft.kind === 'warpgate-ssh') {
    return Boolean(draft.warpgateUsername.trim());
  }

  return true;
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
}): HostFormSubmission {
  const nextTags = dedupeTags(input.tags);
  const nextLabel = input.draft.label.trim() || deriveDefaultHostLabel(input.draft);
  if (!isSshHostDraft(input.draft)) {
    return {
      draft: {
        ...input.draft,
        label: nextLabel,
        tags: nextTags
      }
    };
  }

  const nextDraft: SshHostDraft = {
    ...input.draft,
    label: nextLabel,
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
    <label className="flex flex-col gap-[0.45rem] text-[var(--text)]">
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
  description: string;
  testId?: string;
  children: ReactNode;
}

function FormSection({ title, description, testId, children }: FormSectionProps) {
  return (
    <section
      data-testid={testId}
      className="grid gap-[0.95rem] rounded-[20px] border border-[var(--border)] bg-[var(--surface-muted)] px-[1rem] py-[1rem]"
    >
      <div className="grid gap-[0.3rem]">
        <h3 className="text-[0.95rem] font-semibold tracking-[-0.01em] text-[var(--text)]">{title}</h3>
        <p className="text-[0.84rem] leading-[1.45] text-[var(--text-soft)]">{description}</p>
      </div>
      <div className="grid gap-[0.95rem]">{children}</div>
    </section>
  );
}

export const HostForm = forwardRef<HostFormHandle, HostFormProps>(function HostForm({
  host,
  keychainEntries,
  groupOptions,
  defaultGroupPath = null,
  hideTitle = false,
  onSubmit,
  onConnect,
  onEditExistingSecret,
  onOpenSecrets,
  onActionStateChange
}: HostFormProps, ref) {
  const fieldClassName = 'flex flex-col gap-[0.45rem] text-[var(--text)]';
  const fieldLabelClassName =
    'text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]';
  const {
    pickPrivateKey: pickPrivateKeyFile,
    pickSshCertificate: pickSshCertificateFile,
  } = useHostFormController();
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

  const isEditMode = Boolean(host);

  const sshDraft = isSshHostDraft(draft) ? draft : null;
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
        certificateText: certificateFile?.content
      }),
    [
      certificateFile?.content,
      credentialMode,
      draft,
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
    const options: AwsProfileSelectOption[] = awsProfiles.map((profile) => ({
      value: profile.id ?? profile.name,
      profileId: profile.id ?? null,
      profileName: profile.name,
    }));
    const currentProfileName = draft.awsProfileName.trim();
    const currentProfileId = draft.awsProfileId ?? null;
    const hasCurrentOption = options.some(
      (option) =>
        (currentProfileId && option.profileId === currentProfileId) ||
        option.profileName === currentProfileName,
    );
    if (currentProfileName && !hasCurrentOption) {
      options.unshift({
        value: currentProfileId ?? currentProfileName,
        profileId: currentProfileId,
        profileName: currentProfileName,
        isMissingCurrent: true,
      });
    }
    return options;
  }, [awsProfiles, draft, isAwsDraft]);
  const selectedAwsProfileValue = useMemo(() => {
    if (!isAwsDraft) {
      return '';
    }
    return draft.awsProfileId ?? draft.awsProfileName;
  }, [draft, isAwsDraft]);

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
      setPrivateKeyFile(null);
      setCertificateFile(null);
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
        awsSshMetadataError: host.awsSshMetadataError ?? null
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
        warpgateUsername: host.warpgateUsername
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
        privateKeyPath: host.privateKeyPath ?? '',
        certificatePath: host.certificatePath ?? '',
        secretRef: host.secretRef,
        groupName: host.groupName ?? '',
        terminalThemeId: host.terminalThemeId ?? null
      };
      nextSelectedSecretRef = host.secretRef ?? '';
      nextCredentialMode = host.secretRef ? 'existing' : 'new';
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

    if (credentialMode === 'existing' && selectedSecretRef && !reusableEntries.some((entry) => entry.secretRef === selectedSecretRef)) {
      setSelectedSecretRef('');
      setCredentialMode('new');
    }
  }, [credentialMode, reusableEntries, selectedSecretRef, sshDraft]);

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
    setPrivateKeyFile({ content: selected.content });
    setDraft((current) =>
      isSshHostDraft(current)
        ? { ...current, privateKeyPath: selected.path }
        : current,
    );
  }

  async function pickCertificate(): Promise<void> {
    if (!sshDraft) {
      return;
    }
    const selected = await pickSshCertificateFile();
    if (!selected) {
      return;
    }
    setCertificateFile({ content: selected.content });
    setDraft((current) =>
      isSshHostDraft(current)
        ? { ...current, certificatePath: selected.path }
        : current,
    );
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
          return Boolean(privateKeyFile?.content || nextDraft.privateKeyPath?.trim());
        }
        if (nextDraft.authType === 'certificate') {
          return Boolean(
            (privateKeyFile?.content || nextDraft.privateKeyPath?.trim()) &&
            (certificateFile?.content || nextDraft.certificatePath?.trim())
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
        certificateText: certificateFile?.content
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
      certificateFile?.content,
      privateKeyFile?.content,
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

  const saveStatusText =
    saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? "Couldn't save changes" : null;
  const metadataFields = (
    <>
      <label className={fieldClassName}>
        <span className={fieldLabelClassName}>Label</span>
        <Input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Production API" />
      </label>
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

  useImperativeHandle(ref, () => ({
    submitCreate,
    submitAndConnect
  }), [submitAndConnect, submitCreate]);

  useEffect(() => {
    onActionStateChange?.({
      saveInFlight,
      saveStatusText: isEditMode ? saveStatusText : null
    });
  }, [isEditMode, onActionStateChange, saveInFlight, saveStatusText]);

  return (
    <form
      ref={formRef}
      className="flex flex-col gap-[0.95rem]"
      onSubmit={async (event) => {
        event.preventDefault();
        await submitCreate();
      }}
    >
      {hideTitle ? null : <div className="section-title">Host Editor</div>}
      {sshDraft ? null : metadataFields}

      {isAwsEc2Draft ? (
        <>
          {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}

          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>AWS Profile</span>
            <SelectField
              aria-label="AWS Profile"
              value={selectedAwsProfileValue}
              onChange={(event) => handleAwsProfileChange(event.target.value)}
              disabled={isLoadingAwsProfiles || awsProfileOptions.length === 0}
            >
              {awsProfileOptions.map((profile) => (
                <option key={profile.value} value={profile.value}>
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
        </>
      ) : isAwsEcsDraft ? (
        <>
          {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}

          <label className={fieldClassName}>
            <span className={fieldLabelClassName}>AWS Profile</span>
            <SelectField
              aria-label="AWS Profile"
              value={selectedAwsProfileValue}
              onChange={(event) => handleAwsProfileChange(event.target.value)}
              disabled={isLoadingAwsProfiles || awsProfileOptions.length === 0}
            >
              {awsProfileOptions.map((profile) => (
                <option key={profile.value} value={profile.value}>
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
        </>
      ) : draft.kind === 'warpgate-ssh' ? (
        <>
          {renderTerminalThemeField(draft.terminalThemeId ?? null, (terminalThemeId) => setDraft((current) => ({ ...current, terminalThemeId })))}

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
            <div className="grid gap-[0.75rem] md:grid-cols-[120px_minmax(0,1fr)]">
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
                  const nextAuthType =
                    event.target.value === 'privateKey'
                      ? 'privateKey'
                      : event.target.value === 'certificate'
                        ? 'certificate'
                        : 'password';
                  setDraft({
                    ...sshDraft,
                    authType: nextAuthType,
                    ...(nextAuthType === 'password'
                      ? {
                          privateKeyPath: '',
                          certificatePath: '',
                        }
                      : nextAuthType === 'privateKey'
                        ? {
                            certificatePath: '',
                          }
                        : {})
                  });
                  if (nextAuthType === 'password') {
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
              </SelectField>
            </label>

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
                  <div className="flex gap-[0.75rem]">
                    <Input
                      value={sshDraft.privateKeyPath ?? ''}
                      onChange={(event) => setDraft({ ...sshDraft, privateKeyPath: event.target.value })}
                      placeholder="/Users/.../.ssh/id_ed25519"
                      required
                    />
                    <Button variant="secondary" onClick={pickPrivateKey}>
                      Import
                    </Button>
                  </div>
                </label>
                {sshDraft.authType === 'certificate' ? (
                  <label className={fieldClassName}>
                    <span className={fieldLabelClassName}>SSH certificate file</span>
                    <div className="flex gap-[0.75rem]">
                      <Input
                        value={sshDraft.certificatePath ?? ''}
                        onChange={(event) => setDraft({ ...sshDraft, certificatePath: event.target.value })}
                        placeholder="/Users/.../.ssh/id_ed25519-cert.pub"
                        required
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

            <div className="grid gap-[0.55rem]">
              <div className="flex items-center justify-between gap-3">
                <span className={fieldLabelClassName}>Saved Secret</span>
                {onOpenSecrets && keychainEntries.length > 0 ? (
                  <button
                    type="button"
                    className="border-0 bg-transparent p-0 text-[0.88rem] font-semibold text-[var(--accent-strong)]"
                    onClick={onOpenSecrets}
                  >
                    Secrets 열기
                  </button>
                ) : null}
              </div>
              <SelectField
                aria-label="Saved Secret"
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
                <option value="new">새 secret 생성</option>
                {reusableEntries.map((entry) => (
                  <option key={entry.secretRef} value={`existing:${entry.secretRef}`}>
                    {formatSavedSecretOptionLabel(entry)}
                  </option>
                ))}
              </SelectField>
            </div>

            {credentialMode === 'existing' ? (
              <>
                {host && isSshHostRecord(host) && selectedSecretRef && host.secretRef === selectedSecretRef && onEditExistingSecret && sshDraft.authType !== 'certificate' ? (
                  <Button
                    variant="secondary"
                    onClick={() => onEditExistingSecret(selectedSecretRef, sshDraft.authType === 'password' ? 'password' : 'passphrase')}
                  >
                    {sshDraft.authType === 'password' ? '비밀번호 변경' : 'Passphrase 변경'}
                  </Button>
                ) : null}
              </>
            ) : null}
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
          </FormSection>
        </>
      ) : null}

    </form>
  );
});
