import { describe, expect, it, vi } from 'vitest';
import type { AwsProfileStatus } from '@shared';
import { shouldDisableAwsProfileSelect, shouldDisableAwsRegionSelect, shouldShowAwsProfileAuthError } from './AwsImportDialog';

function createStatus(overrides: Partial<AwsProfileStatus> = {}): AwsProfileStatus {
  return {
    profileName: 'default',
    available: true,
    isSsoProfile: false,
    isAuthenticated: false,
    accountId: null,
    arn: null,
    errorMessage: null,
    missingTools: [],
    ...overrides
  };
}

describe('shouldShowAwsProfileAuthError', () => {
  it('hides the auth error while the profile status is still loading', () => {
    expect(shouldShowAwsProfileAuthError(createStatus(), true)).toBe(false);
  });

  it('shows the auth error only after loading completes with an unauthenticated profile', () => {
    expect(shouldShowAwsProfileAuthError(createStatus(), false)).toBe(true);
    expect(shouldShowAwsProfileAuthError(createStatus({ isAuthenticated: true }), false)).toBe(false);
    expect(shouldShowAwsProfileAuthError(null, false)).toBe(false);
  });
});

describe('AWS import select disabled state', () => {
  it('disables the profile select while any dependent AWS data is loading', () => {
    expect(
      shouldDisableAwsProfileSelect({
        isLoadingProfiles: false,
        isLoadingStatus: true,
        isLoadingRegions: false,
        isLoadingInstances: false,
        isLoggingIn: false,
        profileCount: 1
      })
    ).toBe(true);
    expect(
      shouldDisableAwsProfileSelect({
        isLoadingProfiles: false,
        isLoadingStatus: false,
        isLoadingRegions: false,
        isLoadingInstances: false,
        isLoggingIn: false,
        profileCount: 1
      })
    ).toBe(false);
  });

  it('disables the region select while region or instance data is loading', () => {
    expect(
      shouldDisableAwsRegionSelect({
        isLoadingStatus: false,
        isLoadingRegions: true,
        isLoadingInstances: false,
        isLoggingIn: false,
        regionCount: 1
      })
    ).toBe(true);
    expect(
      shouldDisableAwsRegionSelect({
        isLoadingStatus: false,
        isLoadingRegions: false,
        isLoadingInstances: true,
        isLoggingIn: false,
        regionCount: 1
      })
    ).toBe(true);
    expect(
      shouldDisableAwsRegionSelect({
        isLoadingStatus: false,
        isLoadingRegions: false,
        isLoadingInstances: false,
        isLoggingIn: false,
        regionCount: 1
      })
    ).toBe(false);
  });
});
