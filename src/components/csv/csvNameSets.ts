/**
 * 列名のお気に入り (見出しの無いCSVに付ける列名の並び) の見せ方と、使えるかの判断。
 *
 * 画面の部品から切り離して、テストできるようにしてある
 */
import type { CsvInfo, CsvNameSet } from "../../types";

/**
 * 今のファイルに当たっているお気に入りの名前 (無ければ null)。
 *
 * 覚えておくのではなく、今の列名と見比べて求める (取り消しのあとでもずれない)
 */
export function appliedNameSet(sets: CsvNameSet[], labels: string[]): string | null {
  if (!labels.some((l) => l !== "")) return null;
  const hit = sets.find((s) => labels.every((l, i) => l === (s.columns[i] ?? "")));
  return hit?.name ?? null;
}

/** 一覧に添える中身の見本 (「日付, 店, 金額 ほか3列」) */
export function namePreview(columns: string[], max = 3): string {
  const named = columns.map((c, i) => c || String(i + 1));
  const head = named.slice(0, max).join(", ");
  const rest = named.length - max;
  return rest > 0 ? `${head} ほか${rest}列` : head;
}

/** お気に入りを当てられないときの理由 (当てられれば null) */
export function applyBlocked(info: CsvInfo | null): string | null {
  if (!info) return "ファイルを開いてください";
  if (info.format.fixed) return "固定長のファイルは、固定長設定で項目名を付けます";
  if (info.hasHeader) {
    return "1行目を見出し行として扱っているファイルには当てられません (右下の書式のボタンで切り替えられます)";
  }
  return null;
}

/** 今の列名をお気に入りに保存できないときの理由 (できれば null) */
export function saveBlocked(info: CsvInfo | null): string | null {
  if (!info) return "ファイルを開いてください";
  if (info.format.fixed) return "固定長のファイルは、固定長設定のお気に入りに保存します";
  if (!info.hasHeader && !info.labels.some((l) => l !== "")) {
    return "見出しをダブルクリックして、列に名前を付けてから保存してください";
  }
  return null;
}
