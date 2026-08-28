/** グリッドの行をタブ区切りテキストにしてクリップボードへ渡すための処理 */
import type { DbType } from "./types";

/**
 * 表計算ソフトが数式として読み取ってしまう値の先頭に `'` を足す。
 *
 * Excel / LibreOffice Calc は `=` `+` `-` `@` で始まるセルを数式として扱うため、
 * DBに入っていた文字列がそのまま計算式や外部コマンドの呼び出しになりうる
 * (CSVインジェクション)。ただの数値 (-1 / +3.5) はそのまま出す。
 * CSVファイル出力 (Rust側の export.rs) と同じ判定
 */
export function disarmFormula(text: string): string {
  // 先頭の半角スペースだけ落とす (タブ・復帰はそれ自体が対象なので残す)。
  // Rust側の export.rs と判定をそろえている
  const s = text.replace(/^ +/, "");
  if (!/^[=+\-@\t\r]/.test(s)) return text;
  // 数値として読めるならそのままで安全 (Infinity / NaN は数値扱いしない)。
  // Rust側は末尾の空白があると数値として読まないので、"-1 " だけ判定が違う
  if (s.trim() !== "" && Number.isFinite(Number(s))) return text;
  return `'${text}`;
}

/**
 * セル1つぶんのタブ区切りテキスト。
 *
 * 値にタブや改行が入っていると、貼り付け先で列や行が増えてしまう
 * (先頭がタブの値は、数式対策の `'` だけが別の列に入って対策が外れる)。
 * 表計算ソフトはダブルクォート囲みを解釈するので、そのときだけ囲む。
 *
 * 途中の `"` は囲まなくてもそのまま渡るので触らない。
 * ここで囲むと、テキストエディタやチャットへ貼ったときに
 * `"{""a"": 1}"` のような見た目になってしまう
 */
export function tsvCell(text: string): string {
  const value = disarmFormula(text);
  if (!/[\t\r\n]/.test(value) && !value.startsWith('"')) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** 1セルの値。NULLは空文字と区別するため null で表す */
export type CopyCell = string | null;

/** コピーの形式 */
export type CopyFormat = "tsv" | "tsvHeader" | "json" | "markdown" | "insert";

/**
 * 行要素(<tr>)の並びから、指定した列の値を取り出す。
 *
 * NULLは `.null-cell` で描いているので、文字列の "NULL" と区別できる
 */
export function readCells(
  rows: HTMLElement[],
  colIndexes: number[]
): CopyCell[][] {
  return rows.map((tr) => {
    const cells = Array.from(tr.children) as HTMLElement[];
    return colIndexes.map((i) => {
      const el = cells[i];
      if (!el) return "";
      if (el.querySelector(".null-cell")) return null;
      // 編集中のセルは <input> なので textContent が空になる。
      // NULLの下書き (is-null) は文字列の "NULL" と区別する
      const input = el.querySelector("input, textarea");
      if (
        input instanceof HTMLInputElement ||
        input instanceof HTMLTextAreaElement
      ) {
        return input.classList.contains("is-null") ? null : input.value;
      }
      return el.textContent ?? "";
    });
  });
}

/** 行要素(<tr>)の並びから、指定した列だけをタブ区切りテキストにする */
export function rowsToTsv(rows: HTMLElement[], colIndexes: number[]): string {
  return toTsv(readCells(rows, colIndexes));
}

/** タブ区切り (NULLは空欄。表計算ソフトへ貼る前提) */
export function toTsv(data: CopyCell[][], labels?: string[]): string {
  const body = data.map((r) => r.map((v) => tsvCell(v ?? "")).join("\t"));
  if (labels) body.unshift(labels.map(tsvCell).join("\t"));
  return body.join("\n");
}

/** JSON (1行1オブジェクトの配列。NULLは null のまま) */
export function toJson(data: CopyCell[][], labels: string[]): string {
  // 同じ名前の列 (SELECT a, a) があるとキーが潰れるので、2つ目以降に番号を付ける
  const seen = new Map<string, number>();
  const keys = labels.map((label) => {
    const n = seen.get(label) ?? 0;
    seen.set(label, n + 1);
    return n === 0 ? label : `${label}_${n + 1}`;
  });
  const objs = data.map((row) =>
    Object.fromEntries(keys.map((key, i) => [key, row[i] ?? null]))
  );
  return JSON.stringify(objs, null, 2);
}

/** Markdownの表 (改行とパイプは表が崩れるので置き換える) */
export function toMarkdown(data: CopyCell[][], labels: string[]): string {
  const cell = (v: CopyCell) =>
    v === null ? "" : v.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  const lines = [
    `| ${labels.map(cell).join(" | ")} |`,
    `| ${labels.map(() => "---").join(" | ")} |`,
    ...data.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

/**
 * INSERT文。
 *
 * 画面には型が残っていないため、NULL以外はすべて文字列リテラルにする
 * (DB側が列の型に合わせて解釈するので、数値列でも `'123'` で通る)
 */
export function toInsert(
  data: CopyCell[][],
  quotedTable: string,
  quotedColumns: string[],
  /** MySQLは既定でバックスラッシュもエスケープ扱いになる */
  dbType?: DbType
): string {
  const lit = (v: CopyCell) => {
    if (v === null) return "NULL";
    const escaped =
      dbType === "mysql"
        ? v.replace(/\\/g, "\\\\").replace(/'/g, "''")
        : v.replace(/'/g, "''");
    return `'${escaped}'`;
  };
  const cols = quotedColumns.join(", ");
  return data
    .map((r) => `INSERT INTO ${quotedTable} (${cols}) VALUES (${r.map(lit).join(", ")});`)
    .join("\n");
}

/**
 * クリップボードへ書き込む。
 * navigator.clipboardが使えない環境では隠しテキストエリア経由でコピーする
 */
export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 使えない場合は下のフォールバックへ */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0;";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("コピーできませんでした");
    }
  } finally {
    ta.remove();
  }
}
