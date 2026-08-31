/**
 * JSONのツリーで使うパスの組み立て。
 *
 * 形式は MySQL / PostgreSQL の JSON 関数がそのまま受け取れる JSONPath に合わせる
 * (例: `$.items[0]."商品 名"`)。コピーしてSQLに貼れることを狙っている
 */

/** ツリーの根 */
export const ROOT_PATH = "$";

/** 引用符なしで書けるキーか (英数字とアンダースコアのみ) */
function isPlainKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** 親のパスにオブジェクトのキーを足す */
export function childPath(parent: string, key: string): string {
  if (isPlainKey(key)) return `${parent}.${key}`;
  // 引用符とバックスラッシュはエスケープする
  const escaped = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${parent}."${escaped}"`;
}

/** 親のパスに配列の位置を足す */
export function indexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}
