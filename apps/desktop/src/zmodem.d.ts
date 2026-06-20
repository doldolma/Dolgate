// nora-zmodemjs의 dist는 `<script>`용 빌드라 module.exports가 비어 있고 API를
// window.Zmodem(전역)에 부착한다. 그래서 `import "nora-zmodemjs"`로 side-effect만
// 실행하고 실제 API는 window.Zmodem(ZmodemNamespace)에서 가져온다. 타입은 우리가
// 쓰는 표면(다운로드/수신 + Sentry)만 ambient로 선언한다.

declare module "nora-zmodemjs" {
  export interface ZmodemSentryOptions {
    /** ZMODEM이 아닌 일반 출력 옥텟. 터미널에 그대로 써야 한다. */
    to_terminal: (octets: number[] | Uint8Array) => void;
    /** ZMODEM 피어(원격 PTY)로 보내야 하는 옥텟. */
    sender: (octets: number[]) => void;
    on_detect: (detection: ZmodemDetection) => void;
    on_retract: () => void;
  }

  export interface ZmodemDetection {
    confirm(): ZmodemSession;
    deny(): void;
  }

  export interface ZmodemOfferDetails {
    name: string;
    size?: number;
    mtime?: Date | number | null;
    mode?: number | null;
    files_remaining?: number;
    bytes_remaining?: number;
  }

  export interface ZmodemOffer {
    get_details(): ZmodemOfferDetails;
    get_offset(): number;
    get_payloads(): Array<number[] | Uint8Array>;
    on(event: "input", handler: (octets: number[] | Uint8Array) => void): void;
    accept(): Promise<void>;
    skip(): void;
  }

  export interface ZmodemSession {
    type: "send" | "receive";
    on(event: "offer", handler: (offer: ZmodemOffer) => void): void;
    on(event: "session_end", handler: () => void): void;
    start(): void;
    abort(): void;
    close(): void;
  }

  export interface ZmodemSentryInstance {
    consume(input: ArrayBuffer | Uint8Array | number[]): void;
  }

  export interface ZmodemNamespace {
    Sentry: new (options: ZmodemSentryOptions) => ZmodemSentryInstance;
  }
}

// CommonJS 소스 엔트리. dist(window 전역)와 달리 module.exports로 API를 직접 노출하므로
// 번들/전역에 의존하지 않고 Sentry를 가져올 수 있다.
declare module "nora-zmodemjs/index.js" {
  const Zmodem: import("nora-zmodemjs").ZmodemNamespace;
  export default Zmodem;
}
