import { isRdpHostRecord, type HostRecord, type KnownHostRecord } from '@shared';
import {
  Badge,
  Button,
  Card,
  CardActions,
  CardMain,
  CardMeta,
  CardTitleRow,
  EmptyState,
  PanelSection,
} from '../ui';
import { useTranslation } from 'react-i18next';
import { getFormatLocale } from '../i18n';

interface KnownHostsPanelProps {
  records: KnownHostRecord[];
  onRemove: (id: string) => Promise<void>;
  /**
   * 인증서 신뢰를 훑기 위한 호스트 목록.
   *
   * RDP 신뢰는 known_hosts 가 아니라 호스트 레코드(`certificateFingerprint`)에 있다 — 서버가
   * 대개 자체 서명이라 CA 검증이 성립하지 않아, 처음 접속할 때 지문을 그 호스트에 적어 둔다.
   * 그래서 이 절은 별도 목록이 아니라 호스트를 걸러 만든다.
   */
  hosts: HostRecord[];
  onRevokeRdpCertificate: (hostId: string) => Promise<void>;
}

export function KnownHostsPanel({
  records,
  onRemove,
  hosts,
  onRevokeRdpCertificate,
}: KnownHostsPanelProps) {
  const { t: translate } = useTranslation();
  // 지문을 들고 있는 RDP 호스트만. 라벨 순서는 호스트 목록이 이미 정렬된 채로 온다.
  const trustedRdpHosts = hosts.filter(
    (host) => isRdpHostRecord(host) && Boolean(host.certificateFingerprint),
  );
  return (
    <div className="flex flex-col gap-[1.1rem]">
      <div className="flex items-end justify-between gap-4 px-0 pt-1 pb-2">
        <div>
          <h2 className="m-0">Known Hosts</h2>
          <p className="mt-2 max-w-[48rem] text-[var(--text-soft)]">
            {translate('knownHosts.intro')}
          </p>
        </div>
      </div>

      <PanelSection>
        {records.length === 0 ? (
          <EmptyState
            title={translate('knownHosts.emptyTitle')}
            description={translate('knownHosts.emptyDescription')}
          />
        ) : (
          records.map((record) => (
            <Card key={record.id}>
              <CardMain>
                <CardTitleRow>
                  <strong>
                    {record.host}:{record.port}
                  </strong>
                  <Badge tone="running">{record.algorithm}</Badge>
                </CardTitleRow>
                <CardMeta>
                  <span>{record.fingerprintSha256}</span>
                  <span>Last seen {new Date(record.lastSeenAt).toLocaleString(getFormatLocale())}</span>
                </CardMeta>
              </CardMain>
              <CardActions>
                <Button variant="danger" onClick={() => void onRemove(record.id)}>
                  Remove
                </Button>
              </CardActions>
            </Card>
          ))
        )}
      </PanelSection>

      {/* RDP 서버 인증서 신뢰. 위 목록(SSH 호스트 키)과 저장 위치가 달라 절을 나눠 두지만,
          "이 앱이 무엇을 신뢰하고 있나" 를 한 화면에서 답하기 위해 같은 Security 안에 둔다. */}
      <div className="flex items-end justify-between gap-4 px-0 pt-3 pb-2">
        <div>
          <h2 className="m-0">RDP Certificates</h2>
          <p className="mt-2 max-w-[48rem] text-[var(--text-soft)]">
            {translate('rdpCertificates.intro')}
          </p>
        </div>
      </div>

      <PanelSection>
        {trustedRdpHosts.length === 0 ? (
          <EmptyState
            title={translate('rdpCertificates.emptyTitle')}
            description={translate('rdpCertificates.emptyDescription')}
          />
        ) : (
          trustedRdpHosts.map((host) => (
            <Card key={host.id}>
              <CardMain>
                <CardTitleRow>
                  <strong>{host.label}</strong>
                  <Badge tone="running">RDP</Badge>
                </CardTitleRow>
                <CardMeta>
                  <span>
                    {isRdpHostRecord(host) ? `${host.hostname}:${host.port}` : host.label}
                  </span>
                  {/* 지문은 SHA-256 이다. 인증서 확인 화면이 보여주는 값과 같은 형식이라
                      나란히 대조할 수 있다. */}
                  <span>
                    {isRdpHostRecord(host) ? host.certificateFingerprint : null}
                  </span>
                </CardMeta>
              </CardMain>
              <CardActions>
                <Button
                  variant="danger"
                  onClick={() => void onRevokeRdpCertificate(host.id)}
                >
                  {translate('rdpCertificates.revoke')}
                </Button>
              </CardActions>
            </Card>
          ))
        )}
      </PanelSection>
    </div>
  );
}
