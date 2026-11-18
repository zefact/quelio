/**
 * お気に入り (固定長の桁設定・列名の並び) で、閉じているフォルダを覚えておく。
 *
 * メニューは開くたびに作り直されるので、ここに置いておかないと
 * 開くたびに全部のフォルダが開いた状態へ戻ってしまう。
 * 覚えるのは「閉じているもの」だけにする (新しく作ったフォルダは開いて出したい)
 */

/** 覚えておく場所 (固定長のお気に入り) */
export const LAYOUT_CLOSED_KEY = "quelio.csvLayoutClosed";
/** 覚えておく場所 (列名のお気に入り。固定長とはフォルダが別なので分ける) */
export const NAME_CLOSED_KEY = "quelio.csvNameClosed";

/** 閉じているフォルダの名前を読む (初めて・読めないときは全部開いている) */
export function loadClosed(key: string = LAYOUT_CLOSED_KEY): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((v): v is string => typeof v === "string"));
  } catch {
    // 読めなくても、全部開いて出すだけでよい
    return new Set();
  }
}

/** 閉じているフォルダの名前を覚える */
export function saveClosed(
  closed: ReadonlySet<string>,
  key: string = LAYOUT_CLOSED_KEY
): void {
  try {
    localStorage.setItem(key, JSON.stringify([...closed]));
  } catch {
    // 覚えられなくても開閉はできるので、何もしない
  }
}

/** そのフォルダの開閉を入れ替える */
export function toggleClosed(
  closed: ReadonlySet<string>,
  name: string
): Set<string> {
  const next = new Set(closed);
  if (!next.delete(name)) next.add(name);
  return next;
}

/** フォルダの名前を変えたとき、開閉もその名前へ引き継ぐ */
export function renameClosed(
  closed: ReadonlySet<string>,
  from: string,
  to: string
): Set<string> {
  const next = new Set(closed);
  if (next.delete(from)) next.add(to);
  return next;
}

/** もう無いフォルダの分を捨てる (同じ名前で作り直したときに閉じて出ないように) */
export function pruneClosed(
  closed: ReadonlySet<string>,
  /** 今あるフォルダの名前 */
  names: readonly string[]
): Set<string> {
  return new Set(names.filter((n) => closed.has(n)));
}
