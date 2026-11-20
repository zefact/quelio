/**
 * 接続フォームに書きかけ (まだ保存していない変更) があるか。
 *
 * 一覧で別の接続を選ぶ・ホームへ戻ると、フォームの中身は差し替わる。
 * 黙って消えないよう、差し替える前にこれで確かめて確認を出す。
 * 画面に触れない判定だけなので、そのまま試せる
 */
import type { ConnectionProfile } from "./types";

/**
 * 比べない項目。
 *
 * どれもフォームで書くものではなく、一覧の操作 (色・フォルダ・ピン留め) や
 * 接続した時刻、パスワードを伏せているかの目印として、保存先の側で変わる
 */
const IGNORED = new Set<keyof ConnectionProfile>([
  "folderId",
  "color",
  "pinned",
  "lastUsedAt",
  "passwordLocked",
  "passwordSaved",
  "passphraseSaved",
]);

/**
 * 比べやすい形にそろえる。
 *
 * 「未設定」「空文字」「false」は、画面ではどれも空欄・オフに見えるので同じに扱う。
 * SSH・外部CLIは使っていなければ中身を見ない (オフの間に残った入力は効かないため)
 */
function normalize(value: unknown): unknown {
  if (value === undefined || value === null || value === "" || value === false) {
    return undefined;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("enabled" in obj && !obj.enabled) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const v = normalize(obj[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

/** 比べる項目だけを取り出して、そろえた形にする */
function comparable(p: ConnectionProfile): string {
  const picked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!IGNORED.has(k as keyof ConnectionProfile)) picked[k] = v;
  }
  return JSON.stringify(normalize(picked) ?? {});
}

/**
 * 書きかけがあるか。
 *
 * `saved` は保存済みの同じ接続先 (新しく作っている途中なら、空のフォームの中身)。
 * 見つからないとき (消された直後など) は、比べる相手が無いので書きかけとみなさない
 */
export function isProfileDirty(
  current: ConnectionProfile,
  saved: ConnectionProfile | null | undefined
): boolean {
  if (!saved) return false;
  return comparable(current) !== comparable(saved);
}
