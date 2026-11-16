/**
 * SQLダンプの保存先 (フォルダとファイル名) の扱い。
 *
 * 画面ではフォルダとファイル名を分けて見せ、書き出すときに1つのパスにする。
 * Windows と macOS で区切りが違うので、フォルダのパスに使われている区切りに合わせる
 */

/** フォルダのパスで使われている区切り */
function sepOf(dir: string): string {
  return dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
}

/** フォルダとファイル名を1つのパスにする */
export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  const base = dir.endsWith("/") || dir.endsWith("\\") ? dir.slice(0, -1) : dir;
  return base + sep + name;
}

/** パスをフォルダとファイル名に分ける */
export function splitPath(path: string): { dir: string; name: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return { dir: "", name: path };
  // ルート直下 ("/a.sql") はフォルダを "/" にする
  return { dir: i === 0 ? path.slice(0, 1) : path.slice(0, i), name: path.slice(i + 1) };
}

/** フォルダの名前 (末尾の1段) */
export function folderName(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return splitPath(trimmed).name || dir;
}

/** ファイル名に使えない文字が入っていれば、その説明 */
export function badFileName(name: string): string | null {
  const n = name.trim();
  if (!n) return "ファイル名を入れてください";
  if (/[\\/]/.test(n)) return "ファイル名に / や \\ は使えません";
  if (n === "." || n === "..") return "このファイル名は使えません";
  return null;
}

/** 拡張子が無ければ .sql を付けた名前 (書き出す側も同じように補う) */
export function withSqlExt(name: string): string {
  const n = name.trim();
  // 先頭の "." は隠しファイルの印なので、拡張子とはみなさない
  return n.lastIndexOf(".") > 0 ? n : `${n}.sql`;
}

/* ---------- ファイル名のパターン ---------- */

/** 既定のパターン (これまでの `DB名_日時.sql` と同じ形) */
export const DEFAULT_NAME_PATTERN = "{db}_{date}_{time}";

/** パターンに埋め込む値 */
export interface PatternVars {
  /** DB名 (SQLiteはDBファイルの名前)。バックエンドで安全な形にしたもの */
  db: string;
  /** 接続名 */
  conn: string;
  /** 書き出す内容 (full / schema / data) */
  mode: string;
  /** 書き出すテーブル (画面に出す名前) */
  tables: string[];
}

/** パターンに書ける置き換えと、その説明 (画面のボタンにも使う) */
export const PATTERN_TOKENS: { token: string; label: string; main?: boolean }[] = [
  { token: "db", label: "DB名", main: true },
  { token: "conn", label: "接続名", main: true },
  { token: "date", label: "日付 (20261116)", main: true },
  { token: "time", label: "時刻 (142233)", main: true },
  { token: "mode", label: "内容 (full / schema / data)", main: true },
  { token: "table", label: "テーブル名 (1つのときだけ。複数なら入れない)", main: true },
  { token: "yyyy", label: "年" },
  { token: "MM", label: "月" },
  { token: "dd", label: "日" },
  { token: "HH", label: "時" },
  { token: "mm", label: "分" },
  { token: "ss", label: "秒" },
];

const TOKEN_RE = /\{([A-Za-z]+)\}/g;

/** 埋め込む値をファイル名の一部として使える形にする (区切りなどは _ にする) */
function safePart(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** パターンの中の知らない置き換え (無ければ空) */
export function unknownTokens(pattern: string): string[] {
  const known = new Set(PATTERN_TOKENS.map((t) => t.token));
  const out: string[] = [];
  for (const m of pattern.matchAll(TOKEN_RE)) {
    if (!known.has(m[1]) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** パターンから実際のファイル名を作る (拡張子が無ければ .sql を付ける) */
export function expandPattern(pattern: string, vars: PatternVars, now: Date): string {
  const yyyy = String(now.getFullYear());
  const MM = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const HH = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  // テーブル名は1つのときだけ入れる (複数のときは名前を並べず、空にする)
  const table = vars.tables.length === 1 ? vars.tables[0] : "";
  const values: Record<string, string> = {
    db: vars.db,
    conn: safePart(vars.conn),
    date: yyyy + MM + dd,
    time: HH + mm + ss,
    mode: vars.mode,
    table: safePart(table),
    yyyy,
    MM,
    dd,
    HH,
    mm,
    ss,
  };
  const name = dropEmptyTokens(pattern, values).replace(
    TOKEN_RE,
    (all, key: string) => values[key] ?? all
  );
  // 置き換えが全部空になったときは、DB名にしておく (".sql" だけの名前にしない)
  return withSqlExt(name.trim() ? name : vars.db || "dump");
}

/** つなぎに使われる文字 ({db}_{table} の "_" など) */
const JOINER = "[-_. ]";

/**
 * 空になる置き換えを、つなぎの文字ごと取り除く。
 * {db}_{table}_{date} で {table} が空でも、"shop__20261116" にしないため。
 * 前につなぎがあればそれを、先頭なら後ろのつなぎを消す
 */
function dropEmptyTokens(pattern: string, values: Record<string, string>): string {
  let out = pattern;
  for (const [key, value] of Object.entries(values)) {
    if (value !== "") continue;
    out = out
      .replace(new RegExp(`${JOINER}\\{${key}\\}`, "g"), "")
      .replace(new RegExp(`\\{${key}\\}${JOINER}?`, "g"), "");
  }
  return out;
}

/** パターンの誤り (ファイル名として使えない・知らない置き換えがある) */
export function badPattern(pattern: string): string | null {
  if (!pattern.trim()) return "ファイル名を入れてください";
  const unknown = unknownTokens(pattern);
  if (unknown.length > 0) return `使えない置き換えがあります: ${unknown.join(" ")}`;
  return badFileName(pattern);
}
