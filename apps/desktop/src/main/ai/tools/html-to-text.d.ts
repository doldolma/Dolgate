// html-to-text v10 은 자체 타입 선언을 제공하지 않아 최소 ambient 선언을 둔다(convert 만 사용).
declare module "html-to-text" {
  export function convert(html: string, options?: Record<string, unknown>): string;
}
