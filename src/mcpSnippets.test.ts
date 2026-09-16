import { describe, expect, it } from "vitest";
import {
  claudeCodeSnippet,
  claudeDesktopSnippet,
  endpoint,
  httpClientSnippet,
  maskToken,
  SERVER_NAME,
} from "./mcpSnippets";

const TOKEN = "a".repeat(64);
const PORT = 41777;

describe("endpoint", () => {
  it("手元だけを指す", () => {
    expect(endpoint(PORT)).toBe("http://127.0.0.1:41777/mcp");
    // 外から届く宛先になっていないこと
    expect(endpoint(PORT)).not.toContain("0.0.0.0");
  });
});

describe("Claude Code のスニペット", () => {
  const s = claudeCodeSnippet(PORT, TOKEN);

  it("置き換えの要らない完成形になっている", () => {
    expect(s).toContain(TOKEN);
    expect(s).toContain("41777");
    // 「ここを書き換えて」の類を残さない
    expect(s).not.toContain("<");
  });

  it("現行の書き方を使う", () => {
    expect(s).toContain("claude mcp add --transport http");
    expect(s).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(s).toContain(SERVER_NAME);
  });
});

describe("Claude Desktop のスニペット", () => {
  const s = claudeDesktopSnippet(
    "/Applications/Quelio.app/Contents/MacOS/Quelio",
  );

  it("JSONとして読める", () => {
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it("実行ファイルのパスと --mcp-stdio が入る", () => {
    const j = JSON.parse(s);
    expect(j.mcpServers.quelio.command).toBe(
      "/Applications/Quelio.app/Contents/MacOS/Quelio",
    );
    expect(j.mcpServers.quelio.args).toEqual(["--mcp-stdio"]);
  });

  it("トークンは書かない (中継側がファイルから読む)", () => {
    expect(s).not.toContain("Bearer");
  });

  it("Windowsのパスでも壊れない", () => {
    const win = claudeDesktopSnippet("C:\\Program Files\\Quelio\\Quelio.exe");
    // JSONなのでバックスラッシュは自分で退避される
    expect(JSON.parse(win).mcpServers.quelio.command).toBe(
      "C:\\Program Files\\Quelio\\Quelio.exe",
    );
  });
});

describe("HTTP対応クライアントのスニペット", () => {
  const s = httpClientSnippet(PORT, TOKEN);

  it("JSONとして読める", () => {
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it("urlとAuthorizationが入る", () => {
    const j = JSON.parse(s).mcpServers.quelio;
    expect(j.url).toBe("http://127.0.0.1:41777/mcp");
    expect(j.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("maskToken", () => {
  it("前後だけ残して伏せる", () => {
    const m = maskToken(TOKEN);
    expect(m.startsWith("aaaa")).toBe(true);
    expect(m.endsWith("aaaa")).toBe(true);
    // 中身は残さない
    expect(m).not.toContain(TOKEN);
    expect(m).toContain("•");
  });

  it("短い値は全部伏せる", () => {
    expect(maskToken("abc")).toBe("•••");
  });

  it("空なら空", () => {
    expect(maskToken("")).toBe("");
  });
});
