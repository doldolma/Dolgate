import type { KnownHostRecord } from '@shared';
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

interface KnownHostsPanelProps {
  records: KnownHostRecord[];
  onRemove: (id: string) => Promise<void>;
}

export function KnownHostsPanel({ records, onRemove }: KnownHostsPanelProps) {
  const { t: translate } = useTranslation();
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
                  <span>Last seen {new Date(record.lastSeenAt).toLocaleString('ko-KR')}</span>
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
    </div>
  );
}
