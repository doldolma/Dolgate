import { t } from '../src/i18n';
import { assertSsmManagedInstance } from '../src/lib/aws-ssm-direct';

const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send(...args: unknown[]) {
      return mockSsmSend(...args);
    }
  },
  DescribeInstanceInformationCommand: class {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetDocumentCommand: class {},
  StartSessionCommand: class {},
}));

const target = {
  credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
  region: 'ap-northeast-2',
  instanceId: 'i-0abc',
};

beforeEach(() => {
  mockSsmSend.mockReset();
});

describe('SSM 관리 대상 사전 확인', () => {
  it('온라인 인스턴스는 그대로 통과시킨다', async () => {
    mockSsmSend.mockResolvedValueOnce({
      InstanceInformationList: [{ InstanceId: 'i-0abc', PingStatus: 'Online' }],
    });

    await expect(assertSsmManagedInstance(target)).resolves.toBeUndefined();
    // 인스턴스 하나만 물어본다 — 계정의 관리 대상 전체를 받아 오면 목록이 큰 계정에서 그만큼 느려진다.
    expect(mockSsmSend.mock.calls[0]?.[0]?.input).toEqual({
      Filters: [{ Key: 'InstanceIds', Values: ['i-0abc'] }],
    });
  });

  it('목록에 없으면 관리 대상이 아니라고 말한다', async () => {
    mockSsmSend.mockResolvedValueOnce({ InstanceInformationList: [] });

    await expect(assertSsmManagedInstance(target)).rejects.toThrow(
      t('store.ssmNotManaged'),
    );
  });

  // 관리 대상으로 등록돼 있어도 에이전트가 죽으면 붙지 못한다 — 할 일이 다르므로 문구도 다르다.
  it('에이전트가 연결돼 있지 않으면 그 상태를 알려 준다', async () => {
    mockSsmSend.mockResolvedValueOnce({
      InstanceInformationList: [
        { InstanceId: 'i-0abc', PingStatus: 'ConnectionLost' },
      ],
    });

    await expect(assertSsmManagedInstance(target)).rejects.toThrow(
      'ConnectionLost',
    );
  });

  // 조회가 거부되면 그 원문을 그대로 올린다 — 액션 이름이 그 문장에 들어 있어서, 화면이
  // 정책에 무엇을 추가해야 하는지까지 말해 줄 수 있다.
  it('조회 실패는 삼키지 않고 그대로 올린다', async () => {
    mockSsmSend.mockRejectedValueOnce(
      new Error(
        'User: arn:aws:sts::123456789012:assumed-role/DevRole/dolma is not authorized to perform: ssm:DescribeInstanceInformation',
      ),
    );

    await expect(assertSsmManagedInstance(target)).rejects.toThrow(
      'ssm:DescribeInstanceInformation',
    );
  });
});
