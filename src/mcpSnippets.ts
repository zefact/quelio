/**
 * AIクライアントへ貼る設定文の組み立て。
 *
 * ポートとトークンを埋めた「完成形」を出す。
 * 「<token> を自分のものに置き換えて」と書くと、そこで間違える人がいちばん多い。
 *
 * 各クライアントの設定の形は変わりやすいので、
 * 確認した一次情報を下に残してある (2026年9月時点):
 * - Claude Code: https://code.claude.com/docs/en/mcp
 * - Claude Desktop: https://modelcontextprotocol.io/docs/develop/connect-local-servers
 * - Cursor 等のHTTP対応クライアント: https://cursor.com/docs/context/mcp
 */

/** AIクライアントの設定に書くサーバー名 */
export const SERVER_NAME = "quelio";

/** 待受のエンドポイント */
export function endpoint(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * Claude Code: コマンド1本で登録できる。
 *
 * `--transport http` (streamable HTTP) と `--header` は
 * どちらも現行のドキュメントにある書き方
 */
export function claudeCodeSnippet(port: number, token: string): string {
  return [
    `claude mcp add --transport http ${SERVER_NAME} ${endpoint(port)} \\`,
    `  --header "Authorization: Bearer ${token}"`,
  ].join("\n");
}

/**
 * Claude Desktop: `claude_desktop_config.json` に書く。
 *
 * Claude Desktop はこのファイルでは **stdio のサーバーしか扱えない**
 * (URLを書いても読まれない) ので、Quelio自身を `--mcp-stdio` で起動して
 * 中継させる。`command` はアプリの実行ファイルの絶対パス
 */
export function claudeDesktopSnippet(exePath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: { command: exePath, args: ["--mcp-stdio"] },
      },
    },
    null,
    2,
  );
}

/**
 * HTTP対応クライアント (Cursor など) 向け。
 *
 * `url` と `headers` を書く形 (`type` は要らない)
 */
export function httpClientSnippet(port: number, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          url: endpoint(port),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

/** 設定ファイルの置き場所 (画面に添える案内) */
export const CONFIG_PATHS = {
  claudeDesktop: {
    macos: "~/Library/Application Support/Claude/claude_desktop_config.json",
    windows: "%APPDATA%\\Claude\\claude_desktop_config.json",
  },
  httpClient: "プロジェクトの .cursor/mcp.json (Cursorの場合) など",
} as const;

/** 伏せ字にしたトークン (画面に出すとき用。コピーするのは実物) */
export function maskToken(token: string): string {
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}${"•".repeat(16)}${token.slice(-4)}`;
}
