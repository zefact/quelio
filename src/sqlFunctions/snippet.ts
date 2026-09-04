/**
 * 書式から、入力補完で差し込む形 (スニペット) を作る。
 *
 * `DATE_FORMAT(日時, 書式)` → `DATE_FORMAT(${日時}, ${書式})`
 * ${...} の所はCodeMirrorが「次へ」で渡り歩ける穴になる。
 *
 * 関数の形をしていないもの (`||` `::` `CASE WHEN ...` など) は
 * 補完に出さないので null を返す
 */
import type { SqlFunc } from "./types";

/** 括弧の対応を見ながら、いちばん外側のカンマで割る */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * 引数1つぶんを穴の名前にする。
 *
 * 省略できる引数 (`[, 長さ]`) と可変長 (`...`) は落とす
 */
function holeOf(arg: string): string | null {
  const name = arg
    // 省略できる部分は丸ごと落とす
    .replace(/\[.*?\]/g, "")
    .replace(/[[\]]/g, "")
    .trim();
  if (name === "" || name === "..." || name === "*") return null;
  // 穴の名前に使えない文字は落としておく
  return name.replace(/[{}$]/g, "");
}

/**
 * 補完で差し込む形を返す (関数の形をしていなければ null)。
 *
 * 引数の無い関数は `NOW()` のようにそのまま入れる
 */
export function snippetOf(f: SqlFunc): string | null {
  const head = `${f.name}(`;
  if (!f.signature.startsWith(head)) return null;
  const close = f.signature.lastIndexOf(")");
  if (close < head.length - 1) return null;
  const inner = f.signature.slice(head.length, close);
  const holes = splitArgs(inner)
    .map(holeOf)
    .filter((h): h is string => h !== null);
  if (holes.length === 0) return `${f.name}()`;
  return `${f.name}(${holes.map((h) => `\${${h}}`).join(", ")})`;
}
