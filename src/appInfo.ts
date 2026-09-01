import changelog from "../CHANGELOG.md?raw";

/** 「Quelioについて」などで使うアプリ情報 */
export const APP_NAME = "Quelio";

/** 説明 (対応DBと種別で行を分けて表示する) */
export const APP_TAGLINE_LINES = [
  "MySQL (MariaDB) / PostgreSQL / SQLite",
  "Valkey (Redis) 対応のデータベースクライアント",
];

export const COPYRIGHT = "© ZEFACT Co., Ltd.";

export const SITE_URL = "https://zefact.github.io/quelio/";

/** サイトのリンクに出す短い表記 */
export const SITE_LABEL = "zefact.github.io/quelio";

/**
 * CHANGELOGから該当バージョンのリリース日 (YYYY-MM-DD) を探す。
 * 見出しが無ければ空文字 (未リリースのビルド)
 */
export function releaseDateOf(version: string): string {
  if (!version) return "";
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = changelog.match(
    new RegExp(`^##\\s*\\[${esc}\\]\\s*-\\s*(\\d{4}-\\d{2}-\\d{2})`, "m")
  );
  return m ? m[1] : "";
}

/** 2026-08-20 → 2026年8月20日 */
export function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : iso;
}
