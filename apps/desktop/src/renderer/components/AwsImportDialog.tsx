import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AwsEc2InstanceSummary,
  AwsHostSshInspectionResult,
  AwsProfileStatus,
  AwsProfileSummary,
  HostDraft,
} from '@shared';
import { DialogBackdrop } from './DialogBackdrop';

interface AwsImportDialogProps {
  open: boolean;
  currentGroupPath: string | null;
  onClose: () => void;
  onImport: (draft: HostDraft) => Promise<void>;
}

export function shouldShowAwsProfileAuthError(profileStatus: AwsProfileStatus | null, isLoadingStatus: boolean): boolean {
  return Boolean(profileStatus && !isLoadingStatus && !profileStatus.isAuthenticated);
}

export function shouldDisableAwsProfileSelect(input: {
  isLoadingProfiles: boolean;
  isLoadingStatus: boolean;
  isLoadingRegions: boolean;
  isLoadingInstances: boolean;
  isLoggingIn: boolean;
  profileCount: number;
}): boolean {
  return (
    input.isLoadingProfiles ||
    input.isLoadingStatus ||
    input.isLoadingRegions ||
    input.isLoadingInstances ||
    input.isLoggingIn ||
    input.profileCount === 0
  );
}

export function shouldDisableAwsRegionSelect(input: {
  isLoadingStatus: boolean;
  isLoadingRegions: boolean;
  isLoadingInstances: boolean;
  isLoggingIn: boolean;
  regionCount: number;
}): boolean {
  return input.isLoadingStatus || input.isLoadingRegions || input.isLoadingInstances || input.isLoggingIn || input.regionCount === 0;
}

function normalizeAwsSshPortInput(value: string): string {
  return value.replace(/[^\d]/g, '').slice(0, 5);
}

function toAwsSshPortValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('SSH 포트는 1에서 65535 사이 숫자여야 합니다.');
  }
  return parsed;
}

export function AwsImportDialog({ open, currentGroupPath, onClose, onImport }: AwsImportDialogProps) {
  const [profiles, setProfiles] = useState<AwsProfileSummary[]>([]);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [profileStatus, setProfileStatus] = useState<AwsProfileStatus | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [selectedRegion, setSelectedRegion] = useState('');
  const [instances, setInstances] = useState<AwsEc2InstanceSummary[]>([]);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isLoadingRegions, setIsLoadingRegions] = useState(false);
  const [isLoadingInstances, setIsLoadingInstances] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectionTarget, setInspectionTarget] = useState<AwsEc2InstanceSummary | null>(null);
  const [inspectionStatus, setInspectionStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [inspectionUsernameCandidates, setInspectionUsernameCandidates] = useState<string[]>([]);
  const [inspectionUsername, setInspectionUsername] = useState('');
  const [inspectionPort, setInspectionPort] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const inspectionRequestIdRef = useRef(0);
  const usernameDirtyRef = useRef(false);
  const portDirtyRef = useRef(false);
  const usernameValueRef = useRef('');
  const portValueRef = useRef('');

  const resetInspection = () => {
    inspectionRequestIdRef.current += 1;
    usernameDirtyRef.current = false;
    portDirtyRef.current = false;
    usernameValueRef.current = '';
    portValueRef.current = '';
    setInspectionTarget(null);
    setInspectionStatus('idle');
    setInspectionError(null);
    setInspectionUsernameCandidates([]);
    setInspectionUsername('');
    setInspectionPort('');
    setIsRegistering(false);
  };

  const applyInspectionResult = (result: AwsHostSshInspectionResult) => {
    setInspectionStatus(result.status);
    setInspectionError(result.errorMessage);
    setInspectionUsernameCandidates(result.usernameCandidates);

    if (!usernameDirtyRef.current || !usernameValueRef.current.trim()) {
      const nextUsername = result.recommendedUsername ?? '';
      usernameValueRef.current = nextUsername;
      setInspectionUsername(nextUsername);
    }

    if (!portDirtyRef.current || !portValueRef.current.trim()) {
      const nextPort =
        result.sshPort && Number.isInteger(result.sshPort)
          ? String(result.sshPort)
          : '';
      portValueRef.current = nextPort;
      setInspectionPort(nextPort);
    }
  };

  const inspectInstance = async (
    instance: AwsEc2InstanceSummary,
    preserveEdits: boolean,
  ) => {
    const requestId = inspectionRequestIdRef.current + 1;
    inspectionRequestIdRef.current = requestId;

    if (!preserveEdits) {
      usernameDirtyRef.current = false;
      portDirtyRef.current = false;
      usernameValueRef.current = '';
      portValueRef.current = '';
      setInspectionUsername('');
      setInspectionPort('');
      setInspectionUsernameCandidates([]);
    }

    setInspectionTarget(instance);
    setInspectionStatus('loading');
    setInspectionError(null);

    let result: AwsHostSshInspectionResult;
    try {
      result = await window.dolssh.aws.inspectHostSshMetadata({
        profileName: selectedProfile,
        region: selectedRegion,
        instanceId: instance.instanceId,
        availabilityZone: instance.availabilityZone ?? null,
      });
    } catch (inspectError) {
      result = {
        sshPort: 22,
        recommendedUsername: null,
        usernameCandidates: [],
        status: 'error',
        errorMessage:
          inspectError instanceof Error
            ? inspectError.message
            : 'SSH 접속 정보를 자동으로 확인하지 못했습니다.',
      };
    }

    if (inspectionRequestIdRef.current !== requestId) {
      return;
    }

    applyInspectionResult(result);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    setProfiles([]);
    setSelectedProfile('');
    setProfileStatus(null);
    setRegions([]);
    setSelectedRegion('');
    setInstances([]);
    setError(null);
    resetInspection();
    setIsLoadingProfiles(true);

    void window.dolssh.aws
      .listProfiles()
      .then((items) => {
        setProfiles(items);
        if (items.length > 0) {
          setSelectedProfile(items[0].name);
        }
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : 'AWS 프로필 목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        setIsLoadingProfiles(false);
      });
  }, [open]);

  useEffect(() => {
    if (!open || !selectedProfile) {
      setProfileStatus(null);
      setRegions([]);
      setSelectedRegion('');
      setInstances([]);
      return;
    }

    let cancelled = false;
    setIsLoadingStatus(true);
    setProfileStatus(null);
    setRegions([]);
    setSelectedRegion('');
    setInstances([]);
    setError(null);

    void window.dolssh.aws
      .getProfileStatus(selectedProfile)
      .then((status) => {
        if (cancelled) {
          return;
        }
        setProfileStatus(status);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'AWS 프로필 상태를 확인하지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingStatus(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, selectedProfile]);

  useEffect(() => {
    if (!open || !selectedProfile || !profileStatus?.isAuthenticated) {
      setIsLoadingRegions(false);
      setRegions([]);
      setSelectedRegion('');
      setInstances([]);
      return;
    }

    let cancelled = false;
    setIsLoadingRegions(true);
    setError(null);

    void window.dolssh.aws
      .listRegions(selectedProfile)
      .then((nextRegions) => {
        if (cancelled) {
          return;
        }
        setRegions(nextRegions);
        setSelectedRegion((current) => (current && nextRegions.includes(current) ? current : nextRegions[0] ?? ''));
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'AWS 리전 목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRegions(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, profileStatus?.isAuthenticated, selectedProfile]);

  useEffect(() => {
    if (!open || !selectedProfile || !selectedRegion || !profileStatus?.isAuthenticated) {
      setIsLoadingInstances(false);
      setInstances([]);
      return;
    }

    let cancelled = false;
    setIsLoadingInstances(true);
    setError(null);

    void window.dolssh.aws
      .listEc2Instances(selectedProfile, selectedRegion)
      .then((items) => {
        if (cancelled) {
          return;
        }
        setInstances(items);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'EC2 인스턴스 목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingInstances(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, profileStatus?.isAuthenticated, selectedProfile, selectedRegion]);

  const missingTools = useMemo(() => profileStatus?.missingTools ?? [], [profileStatus?.missingTools]);
  const loadingMessage = inspectionTarget
    ? null
    : isLoadingProfiles
      ? 'AWS 프로필을 불러오는 중입니다.'
      : isLoadingStatus
        ? '프로필 로그인 상태를 확인하는 중입니다.'
        : isLoggingIn
          ? '브라우저에서 AWS 로그인을 진행 중입니다.'
          : isLoadingRegions
            ? '리전 목록을 불러오는 중입니다.'
            : isLoadingInstances
              ? 'EC2 인스턴스 목록을 불러오는 중입니다.'
              : null;
  const inspectionCandidateChips = useMemo(
    () =>
      [...new Set(inspectionUsernameCandidates.filter(Boolean))].filter(
        (candidate) => candidate.trim() !== inspectionUsername.trim(),
      ),
    [inspectionUsername, inspectionUsernameCandidates],
  );

  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop
      onDismiss={onClose}
      dismissDisabled={isRegistering}
    >
      <div className="modal-card aws-import-dialog" role="dialog" aria-modal="true" aria-labelledby="aws-import-title">
        <div className="modal-card__header">
          <div>
            <div className="section-kicker">AWS</div>
            <h3 id="aws-import-title">Import from AWS</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close AWS import dialog" disabled={isRegistering}>
            ×
          </button>
        </div>

        <div className="modal-card__body">
          <div className="form-grid">
            <label className="form-field">
              <span>Profile</span>
              <select
                value={selectedProfile}
                onChange={(event) => setSelectedProfile(event.target.value)}
                disabled={
                  shouldDisableAwsProfileSelect({
                    isLoadingProfiles,
                    isLoadingStatus,
                    isLoadingRegions,
                    isLoadingInstances,
                    isLoggingIn,
                    profileCount: profiles.length
                  }) || Boolean(inspectionTarget)
                }
              >
                {profiles.length === 0 ? <option value="">No profiles found</option> : null}
                {profiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>

            {profileStatus?.isAuthenticated ? (
              <>
                <label className="form-field">
                  <span>Region</span>
                  <select
                    value={selectedRegion}
                    onChange={(event) => setSelectedRegion(event.target.value)}
                    disabled={
                      shouldDisableAwsRegionSelect({
                        isLoadingStatus,
                        isLoadingRegions,
                        isLoadingInstances,
                        isLoggingIn,
                        regionCount: regions.length
                      }) || Boolean(inspectionTarget)
                    }
                  >
                    {regions.length === 0 ? <option value="">No regions found</option> : null}
                    {regions.map((region) => (
                      <option key={region} value={region}>
                        {region}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>

          {loadingMessage ? <div className="aws-import-dialog__loading">{loadingMessage}</div> : null}

          {shouldShowAwsProfileAuthError(profileStatus, isLoadingStatus) && profileStatus ? (
            <div className="terminal-error-banner">
              {profileStatus.isSsoProfile
                ? '이 프로필은 아직 로그인되지 않았습니다. 브라우저에서 AWS SSO 로그인을 완료해 주세요.'
                : profileStatus.errorMessage || '이 프로필은 AWS CLI 자격 증명이 필요합니다.'}
            </div>
          ) : null}

          {missingTools.length > 0 ? (
            <div className="terminal-error-banner">
              {missingTools.includes('aws-cli') ? 'AWS CLI가 설치되어 있어야 합니다. ' : ''}
              {missingTools.includes('session-manager-plugin') ? 'session-manager-plugin이 설치되어 있어야 SSM 연결을 시작할 수 있습니다.' : ''}
            </div>
          ) : null}

          {profileStatus?.isSsoProfile && !profileStatus.isAuthenticated ? (
            <div className="modal-card__footer aws-import-dialog__inline-actions">
              <button
                type="button"
                className="primary-button"
                onClick={async () => {
                  if (!selectedProfile) {
                    return;
                  }
                  setIsLoggingIn(true);
                  setError(null);
                  try {
                    await window.dolssh.aws.login(selectedProfile);
                    const status = await window.dolssh.aws.getProfileStatus(selectedProfile);
                    setProfileStatus(status);
                  } catch (loginError) {
                    setError(loginError instanceof Error ? loginError.message : 'AWS SSO 로그인을 시작하지 못했습니다.');
                  } finally {
                    setIsLoggingIn(false);
                  }
                }}
                disabled={isLoggingIn}
              >
                {isLoggingIn ? '로그인 중...' : '브라우저에서 로그인'}
              </button>
            </div>
          ) : null}

          {error ? <div className="terminal-error-banner">{error}</div> : null}

          {inspectionTarget ? (
            <div className="aws-import-dialog__inspection" data-testid="aws-import-inspection">
              <article className="operations-card aws-import-dialog__inspection-summary">
                <div className="operations-card__main">
                  <div className="operations-card__title-row">
                    <strong>{inspectionTarget.name || inspectionTarget.instanceId}</strong>
                    <span className="status-pill status-pill--running">{inspectionTarget.state || 'unknown'}</span>
                  </div>
                  <div className="operations-card__meta">
                    <span>{inspectionTarget.instanceId}</span>
                    <span>{selectedRegion}</span>
                    <span>{inspectionTarget.availabilityZone || 'AZ unavailable'}</span>
                    <span>{inspectionTarget.privateIp || 'No private IP'}</span>
                    <span>{inspectionTarget.platform || 'linux'}</span>
                  </div>
                </div>
              </article>

              {inspectionStatus === 'loading' ? (
                <div className="aws-import-dialog__loading">
                  유저명 및 SSH 접속 정보를 확인 중입니다.
                </div>
              ) : null}

              {inspectionStatus === 'ready' ? (
                <div className="empty-callout aws-import-dialog__inspection-callout">
                  <strong>자동으로 SSH 접속 정보를 확인했습니다.</strong>
                  <p>필요하면 아래 값을 바로 수정한 뒤 Host를 등록할 수 있습니다.</p>
                </div>
              ) : null}

              {inspectionStatus === 'error' && inspectionError ? (
                <div className="terminal-error-banner">{inspectionError}</div>
              ) : null}

              <div className="form-grid aws-import-dialog__inspection-fields">
                <label className="form-field">
                  <span>SSH Username</span>
                  <input
                    value={inspectionUsername}
                    onChange={(event) => {
                      usernameDirtyRef.current = true;
                      usernameValueRef.current = event.target.value;
                      setInspectionUsername(event.target.value);
                    }}
                    placeholder="자동으로 찾은 사용자명이 없으면 비워둘 수 있습니다."
                    disabled={inspectionStatus === 'loading' || isRegistering}
                  />
                </label>

                <label className="form-field">
                  <span>SSH Port</span>
                  <input
                    inputMode="numeric"
                    value={inspectionPort}
                    onChange={(event) => {
                      const nextValue = normalizeAwsSshPortInput(event.target.value);
                      portDirtyRef.current = true;
                      portValueRef.current = nextValue;
                      setInspectionPort(nextValue);
                    }}
                    placeholder="비워두면 기본값 22를 사용합니다."
                    disabled={inspectionStatus === 'loading' || isRegistering}
                  />
                </label>
              </div>

              {inspectionCandidateChips.length > 0 ? (
                <div className="aws-import-dialog__chips">
                  {inspectionCandidateChips.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      className="secondary-button aws-import-dialog__chip"
                      disabled={inspectionStatus === 'loading' || isRegistering}
                      onClick={() => {
                        usernameDirtyRef.current = true;
                        usernameValueRef.current = candidate;
                        setInspectionUsername(candidate);
                      }}
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : profileStatus?.isAuthenticated && selectedRegion ? (
            <div className="aws-import-dialog__instance-list" data-testid="aws-import-instance-list">
              <div className="operations-list">
              {instances.length === 0 && !isLoadingInstances ? (
                <div className="empty-callout">
                  <strong>이 리전에 가져올 수 있는 EC2 인스턴스가 없습니다.</strong>
                </div>
              ) : (
                instances.map((instance) => (
                  <article key={instance.instanceId} className="operations-card">
                    <div className="operations-card__main">
                      <div className="operations-card__title-row">
                        <strong>{instance.name || instance.instanceId}</strong>
                        <span className="status-pill status-pill--running">{instance.state || 'unknown'}</span>
                      </div>
                      <div className="operations-card__meta">
                        <span>{instance.instanceId}</span>
                        <span>{selectedRegion}</span>
                        <span>{instance.availabilityZone || 'AZ unavailable'}</span>
                        <span>{instance.privateIp || 'No private IP'}</span>
                        <span>{instance.platform || 'linux'}</span>
                      </div>
                    </div>
                    <div className="operations-card__actions">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={
                          /windows/i.test(instance.platform || '')
                        }
                        onClick={async () => {
                          await inspectInstance(instance, false);
                        }}
                      >
                        {/windows/i.test(instance.platform || '') ? 'Windows 미지원' : 'SSH 정보 확인'}
                      </button>
                    </div>
                  </article>
                ))
              )}
              </div>
            </div>
          ) : null}
        </div>

        <div className="modal-card__footer">
          {inspectionTarget ? (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={inspectionStatus === 'loading' || isRegistering}
                onClick={() => {
                  resetInspection();
                }}
              >
                뒤로
              </button>
              <div className="aws-import-dialog__footer-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={inspectionStatus === 'loading' || isRegistering}
                  onClick={() => {
                    void inspectInstance(inspectionTarget, true);
                  }}
                >
                  다시 확인
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={inspectionStatus === 'loading' || isRegistering}
                  onClick={async () => {
                    try {
                      const sshPort = toAwsSshPortValue(inspectionPort);
                      const sshUsername = inspectionUsername.trim() || null;
                      setInspectionError(null);
                      setIsRegistering(true);
                      await onImport({
                        kind: 'aws-ec2',
                        label: inspectionTarget.name || inspectionTarget.instanceId,
                        groupName: currentGroupPath ?? '',
                        terminalThemeId: null,
                        awsProfileName: selectedProfile,
                        awsRegion: selectedRegion,
                        awsInstanceId: inspectionTarget.instanceId,
                        awsAvailabilityZone: inspectionTarget.availabilityZone || null,
                        awsInstanceName: inspectionTarget.name || null,
                        awsPlatform: inspectionTarget.platform || null,
                        awsPrivateIp: inspectionTarget.privateIp || null,
                        awsState: inspectionTarget.state || null,
                        awsSshUsername: sshUsername,
                        awsSshPort: sshPort,
                        awsSshMetadataStatus: sshUsername ? 'ready' : 'idle',
                        awsSshMetadataError: null
                      });
                      onClose();
                    } catch (submitError) {
                      setInspectionStatus('error');
                      setInspectionError(submitError instanceof Error ? submitError.message : 'AWS host를 등록하지 못했습니다.');
                    } finally {
                      setIsRegistering(false);
                    }
                  }}
                >
                  {isRegistering ? '등록 중...' : 'Host 등록'}
                </button>
              </div>
            </>
          ) : (
            <div className="aws-import-dialog__footer-actions">
              <button type="button" className="secondary-button" onClick={onClose}>
                닫기
              </button>
            </div>
          )}
        </div>
      </div>
    </DialogBackdrop>
  );
}
