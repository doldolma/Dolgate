import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  loadAwsProfileDocuments,
  resolveAwsSsoChain,
} from './aws-profile-files';

const tempDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirectories.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function documentsFrom(config: string, credentials = '') {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), 'dolgate-aws-sso-chain-'),
  );
  tempDirectories.push(rootDir);
  await mkdir(rootDir, { recursive: true });
  await writeFile(path.join(rootDir, 'config'), config, 'utf8');
  await writeFile(path.join(rootDir, 'credentials'), credentials, 'utf8');
  return loadAwsProfileDocuments(rootDir);
}

describe('resolveAwsSsoChain', () => {
  it('follows source_profile to the sso_session that owns the login', async () => {
    // assume role 프로필에서 실제로 깨졌던 모양 — SSO 설정이 source_profile 쪽에만 있다.
    const documents = await documentsFrom(`
[profile prod]
role_arn = arn:aws:iam::123456789012:role/Admin
source_profile = sso-base
region = ap-northeast-2

[profile sso-base]
sso_session = corp
sso_account_id = 123456789012
sso_role_name = ViewOnly

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = us-east-1
`);

    expect(resolveAwsSsoChain(documents, 'prod')).toEqual({
      profileName: 'sso-base',
      ssoSessionName: 'corp',
      startUrl: 'https://corp.awsapps.com/start',
      ssoRegion: 'us-east-1',
      hopCount: 1,
    });
  });

  it('supports the legacy form where the source profile inlines sso_start_url', async () => {
    const documents = await documentsFrom(`
[profile prod]
role_arn = arn:aws:iam::123456789012:role/Admin
source_profile = legacy-sso

[profile legacy-sso]
sso_start_url = https://legacy.awsapps.com/start
sso_region = eu-west-1
`);

    expect(resolveAwsSsoChain(documents, 'prod')).toMatchObject({
      profileName: 'legacy-sso',
      ssoSessionName: null,
      startUrl: 'https://legacy.awsapps.com/start',
      ssoRegion: 'eu-west-1',
    });
  });

  it('walks nested source_profile hops', async () => {
    const documents = await documentsFrom(`
[profile outer]
role_arn = arn:aws:iam::1:role/A
source_profile = middle

[profile middle]
role_arn = arn:aws:iam::2:role/B
source_profile = inner

[profile inner]
sso_start_url = https://nested.awsapps.com/start
sso_region = ap-south-1
`);

    expect(resolveAwsSsoChain(documents, 'outer')).toMatchObject({
      profileName: 'inner',
      hopCount: 2,
    });
  });

  it('returns the profile itself when it already owns the SSO config', async () => {
    const documents = await documentsFrom(`
[profile direct]
sso_session = corp

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = us-east-1
`);

    expect(resolveAwsSsoChain(documents, 'direct')).toMatchObject({
      profileName: 'direct',
      hopCount: 0,
    });
  });

  it('stops at a declared sso_session even when the session section is missing', async () => {
    // SSO 의사 표시가 있으면 값이 없어도 SSO 로 분류해야 한다 — static 자격 증명 프로필로
    // 오판하면 "저장된 자격 증명 실패" 로 끝나고, 설정 누락이라는 진짜 원인이 가려진다.
    const documents = await documentsFrom(`
[profile prod]
role_arn = arn:aws:iam::1:role/A
source_profile = broken

[profile broken]
sso_session = missing-session
`);

    expect(resolveAwsSsoChain(documents, 'prod')).toMatchObject({
      profileName: 'broken',
      ssoSessionName: 'missing-session',
      startUrl: '',
      ssoRegion: '',
    });
  });

  it('returns null when the chain ends in static keys or credential_process', async () => {
    const staticDocuments = await documentsFrom(
      `
[profile prod]
role_arn = arn:aws:iam::1:role/A
source_profile = keys
`,
      `
[keys]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = secret
`,
    );
    expect(resolveAwsSsoChain(staticDocuments, 'prod')).toBeNull();

    const processDocuments = await documentsFrom(`
[profile prod]
role_arn = arn:aws:iam::1:role/A
source_profile = helper

[profile helper]
credential_process = /usr/local/bin/creds
`);
    expect(resolveAwsSsoChain(processDocuments, 'prod')).toBeNull();
  });

  it('returns null for an unknown profile or a source_profile cycle', async () => {
    const documents = await documentsFrom(`
[profile a]
role_arn = arn:aws:iam::1:role/A
source_profile = b

[profile b]
role_arn = arn:aws:iam::2:role/B
source_profile = a
`);

    // 순환이면 무한 루프 없이 null 로 떨어져야 한다.
    expect(resolveAwsSsoChain(documents, 'a')).toBeNull();
    expect(resolveAwsSsoChain(documents, 'does-not-exist')).toBeNull();
  });
});
