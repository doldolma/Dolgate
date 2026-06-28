import type { HostEnvVar } from "@shared";
import { Button, Input } from "../ui";

interface EnvironmentVariablesEditorProps {
  variables: HostEnvVar[];
  onChange: (variables: HostEnvVar[]) => void;
  disabled?: boolean;
}

// 연결 시 셸에 주입할 환경변수(KEY=VALUE) 행 편집기. 값은 비밀번호처럼
// 암호화 시크릿 번들에 저장된다(상위에서 처리).
export function EnvironmentVariablesEditor({
  variables,
  onChange,
  disabled = false,
}: EnvironmentVariablesEditorProps) {
  function updateAt(index: number, patch: Partial<HostEnvVar>): void {
    onChange(
      variables.map((variable, current) =>
        current === index ? { ...variable, ...patch } : variable,
      ),
    );
  }

  function removeAt(index: number): void {
    onChange(variables.filter((_, current) => current !== index));
  }

  function addRow(): void {
    onChange([...variables, { key: "", value: "" }]);
  }

  return (
    <div className="grid gap-[0.55rem]">
      {variables.map((variable, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] items-center gap-[0.55rem]"
        >
          <Input
            aria-label="환경변수 이름"
            placeholder="KEY"
            value={variable.key}
            disabled={disabled}
            onChange={(event) => updateAt(index, { key: event.target.value })}
          />
          <Input
            aria-label="환경변수 값"
            placeholder="VALUE"
            value={variable.value}
            disabled={disabled}
            onChange={(event) => updateAt(index, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => removeAt(index)}
            aria-label="환경변수 삭제"
          >
            삭제
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={addRow}
        >
          + 변수 추가
        </Button>
      </div>
    </div>
  );
}
