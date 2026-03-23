import { useEffect, useMemo, useState } from 'react';
import type { AwsEc2InstanceSummary, AwsProfileStatus, AwsProfileSummary, HostDraft } from '@shared';

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
  const loadingMessage = isLoadingProfiles
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

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card aws-import-dialog" role="dialog" aria-modal="true" aria-labelledby="aws-import-title">
        <div className="modal-card__header">
          <div>
            <div className="section-kicker">AWS</div>
            <h3 id="aws-import-title">Import from AWS</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close AWS import dialog">
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
                  })
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
                    })
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

          {profileStatus?.isAuthenticated && selectedRegion ? (
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
                        <span>{instance.privateIp || 'No private IP'}</span>
                        <span>{instance.platform || 'linux'}</span>
                      </div>
                    </div>
                    <div className="operations-card__actions">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={async () => {
                          await onImport({
                            kind: 'aws-ec2',
                            label: instance.name || instance.instanceId,
                            groupName: currentGroupPath ?? '',
                            terminalThemeId: null,
                            awsProfileName: selectedProfile,
                            awsRegion: selectedRegion,
                            awsInstanceId: instance.instanceId,
                            awsInstanceName: instance.name || null,
                            awsPlatform: instance.platform || null,
                            awsPrivateIp: instance.privateIp || null,
                            awsState: instance.state || null
                          });
                          onClose();
                        }}
                      >
                        Add host
                      </button>
                    </div>
                  </article>
                ))
              )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
