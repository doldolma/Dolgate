import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_URL_SCHEMES, classifyProtocolUrl, findProtocolUrl } from "./protocol-links";

const INVITE = "https://sync.example.com/invite/k3Hq9xAb#v1.Qm9vYmFyYmF6";

describe("app protocol links", () => {
  it("reads a team invite from the invite scheme, # and all", () => {
    expect(classifyProtocolUrl(`dolgate-invite://join?link=${encodeURIComponent(INVITE)}`)).toEqual({
      kind: "team-invite",
      link: INVITE,
    });
  });

  it("keeps the login callback on dolgate://auth", () => {
    const raw = "dolgate://auth/callback?code=abc&state=xyz";
    expect(classifyProtocolUrl(raw)).toEqual({ kind: "auth-callback", url: raw });
  });

  // 옛 앱처럼 모르는 dolgate:// 를 로그인 콜백으로 읽으면, 콜백이 아니라서 세션을 지운다(로그아웃).
  it("ignores any other address instead of reading it as a login callback", () => {
    for (const raw of [
      "dolgate://team-invite?link=x",
      "dolgate://aws-sso/callback?code=1",
      "dolgate-invite://join",
      "dolgate-invite://join?link=%20",
      "https://sync.example.com/auth/callback?code=1",
      "not a url",
    ]) {
      expect(classifyProtocolUrl(raw), raw).toEqual({ kind: "ignored" });
    }
  });

  it("finds an app address among launch arguments", () => {
    const invite = `dolgate-invite://join?link=${encodeURIComponent(INVITE)}`;
    expect(findProtocolUrl(["/opt/Dolgate/dolgate", "--no-sandbox", invite])).toBe(invite);
    expect(findProtocolUrl(["dolgate.exe", "dolgate://auth/callback?code=1"])).toBe("dolgate://auth/callback?code=1");
    expect(findProtocolUrl(["dolgate.exe", "--new-window"])).toBeNull();
  });

  // 설치판이 OS 에 등록하는 스킴과 앱이 받는 스킴이 어긋나면 링크 페이지의 `앱 열기` 가 아무 일도 안 한다.
  // 빌드 설정을 런타임에 import 하지 않으려고 소스를 읽어 비교한다(main.window-association.test.ts 와 같다).
  it("registers exactly the schemes the app reads in both packaging configs", () => {
    for (const config of ["../../electron-builder.config.cjs", "../../forge.config.ts"]) {
      const source = readFileSync(path.resolve(__dirname, config), "utf8");
      const schemes = /schemes:\s*\[([^\]]*)\]/.exec(source)?.[1];
      expect(schemes, config).toBeDefined();
      expect(
        [...schemes!.matchAll(/'([^']+)'/g)].map((match) => match[1]),
        config,
      ).toEqual([...APP_URL_SCHEMES]);
    }
  });
});
