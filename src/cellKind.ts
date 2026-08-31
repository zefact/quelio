/**
 * 値から列の種類を見分ける (表示をそろえるためだけに使う)。
 *
 * 結果グリッドは列の型を持っていない (SQLの結果は文字列で受け取る) ので、
 * 表示中のページの値から見分ける。
 * 数えるのは見た目 (右寄せ・色) を決めるためだけで、
 * コピー・CSV・編集の中身には一切影響しない
 */

export type CellKind = "number" | "date" | "bool" | "text";

/**
 * 数値。先頭に0が続くもの (郵便番号・伝票番号など) は数値として扱わない。
 * 桁をそろえて書いてある「コード」を右寄せすると、かえって読みにくいため
 */
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** 日付・日時 (ISO形式。DBが返す `2026-08-31 12:34:56` も含む) */
const DATE =
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** 真偽 (PostgreSQLの `t` / `f` も含む) */
const BOOL = /^(true|false|t|f)$/i;

/** 値1つの種類 */
export function cellKind(value: string): CellKind {
  if (NUMBER.test(value)) return "number";
  if (DATE.test(value)) return "date";
  if (BOOL.test(value)) return "bool";
  return "text";
}

/**
 * 列ごとの種類。
 *
 * NULLは数えず、残りが全部同じ種類のときだけその種類にする。
 * 1つでも違えば text (中途半端に右寄せされるより、そろっている方が読みやすい)
 */
export function columnKinds(
  rows: readonly (readonly (string | null)[])[],
  colCount: number
): CellKind[] {
  const kinds: (CellKind | null)[] = Array(colCount).fill(null);
  /** まだ判定が要る列の数 (全部 text に落ちたら早く抜ける) */
  let pending = colCount;
  for (const row of rows) {
    if (pending === 0) break;
    for (let i = 0; i < colCount; i++) {
      if (kinds[i] === "text") continue;
      const v = row[i];
      if (v === null || v === undefined) continue;
      const k = cellKind(v);
      if (kinds[i] === null) {
        kinds[i] = k;
        if (k === "text") pending--;
      } else if (kinds[i] !== k) {
        kinds[i] = "text";
        pending--;
      }
    }
  }
  // 値が1つも無かった列 (全部NULL) は text 扱い
  return kinds.map((k) => k ?? "text");
}

/** 右寄せにする列か */
export function kindAlign(kind: CellKind): "right" | undefined {
  return kind === "number" ? "right" : undefined;
}

/** セルに付ける class (色を変えない種類は undefined) */
export function kindClass(kind: CellKind): string | undefined {
  if (kind === "date") return "cell-date";
  if (kind === "bool") return "cell-bool";
  return undefined;
}
