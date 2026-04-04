import type { KnownHostRecord } from '@shared';
import { Badge, Button, Card, CardActions, CardMain, CardMeta, CardTitleRow, EmptyState, SectionLabel } from '../ui';

interface KnownHostsPanelProps {
  records: KnownHostRecord[];
  onRemove: (id: string) => Promise<void>;
}

export function KnownHostsPanel({ records, onRemove }: KnownHostsPanelProps) {
  return (
    <div className="flex flex-col gap-[1.05rem]">
      <div className="flex items-end justify-between gap-4 px-0 pt-1 pb-2">
        <div>
          <SectionLabel>Security</SectionLabel>
          <h2 className="m-0">Known Hosts</h2>
          <p className="mt-2 max-w-[48rem] text-[var(--text-soft)]">
            신뢰한 호스트 키 목록입니다. 새 연결은 이 목록과 정확히 일치해야만 진행됩니다.
          </p>
        </div>
      </div>

      <div className="operations-list">
        {records.length === 0 ? (
          <EmptyState
            title="아직 저장된 known host가 없습니다."
            description="처음 연결하는 서버의 지문을 승인하면 이 목록에 자동으로 추가됩니다."
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
      </div>
    </div>
  );
}
