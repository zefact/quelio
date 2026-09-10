/**
 * 貼り付けを、選んでいる範囲へどう当てるかの計算。
 *
 * 値が1つだけのときは、選んだ範囲を全部その値で埋める (表計算ソフトと同じ)。
 * 中身が表のときは、選んだ範囲の左上から流し込む。
 *
 * 画面の描き方とは切り離してあるので、当て方だけを試せる
 */
import type { CsvCellPatch } from "../../types";
import type { CsvCursor, CsvRange } from "./csvSelection";

/**
 * クリップボードが「値1つ」なら、その値を返す (表なら null)。
 *
 * 表計算ソフトは1セルのコピーにも末尾の改行を付けることがあるので、
 * 最後の改行1つだけは値の一部とみなさない
 */
export function singleValue(text: string): string | null {
  const body = text.replace(/\r?\n$/, "");
  if (/[\t\r\n]/.test(body)) return null;
  return body;
}

/**
 * 選んでいる範囲を、すべて同じ値にする指定を作る。
 *
 * ⌘+クリックで足した四角が重なっていても、同じセルは1回だけ出す
 */
export function fillPatches(
  ranges: CsvRange[],
  value: string
): CsvCellPatch[] {
  const seen = new Set<string>();
  const out: CsvCellPatch[] = [];
  for (const r of ranges) {
    for (let row = r.top; row <= r.bottom; row++) {
      for (let col = r.left; col <= r.right; col++) {
        const key = `${row}:${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ row, col, value });
      }
    }
  }
  return out;
}

/**
 * 表を流し込むときに、左上にするセル。
 *
 * 範囲を1つだけ選んでいるなら、その左上から入れる。
 * ドラッグの向きによってカーソルは右下にも来るので、カーソルは使わない
 * (離れた所をいくつも選んでいるときは、どこが左上か決められないのでカーソル)
 */
export function pasteAnchor(cursor: CsvCursor, ranges: CsvRange[]): CsvCursor {
  if (ranges.length !== 1) return cursor;
  return { row: ranges[0].top, col: ranges[0].left };
}
