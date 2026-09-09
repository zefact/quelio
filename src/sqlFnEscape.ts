/**
 * 「文の始まり」と読まれてしまう名前の関数を、整形の間だけ逃がす。
 *
 * `TRUNCATE(x, 0)` は TRUNCATE文、`REPLACE(a, b, c)` は REPLACE INTO文 と
 * 読まれてしまい、その行から字下げが崩れる。
 * 整形の前に当たり障りのない名前へ置き換え、整形のあとに
 * 書いてあったとおりの名前へ戻す。
 *
 * 文字列・引用符付きの名前・コメントの中は触らない
 * (`'truncate ('` のような中身まで書き換えてしまわないため)
 */

/** 逃がす名前 (小文字で持つ。大小は問わない) */
const KEYWORD_FUNCTIONS = ["replace", "truncate", "insert", "repeat"];

/** 逃がし先の名前の頭 (ふつうのSQLには出てこない綴り) */
const MARK = "QUELIO_FN_";

/** 戻すときの目印 (整形器が `(` の前に空白を入れることがある) */
const MARK_BACK = /QUELIO_FN_(\d+)\s*\(/g;

/** 逃がした結果 */
export interface Escaped {
  sql: string;
  /** 逃がした名前を、出てきた順に (書いてあったとおりの綴り) */
  names: string[];
}

/** 名前の1文字目に使えるか (日本語の名前もあるので、記号以外は通す) */
function wordStart(c: string): boolean {
  return /[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127;
}

/** 名前の2文字目以降に使えるか */
function wordChar(c: string): boolean {
  return wordStart(c) || /[0-9$]/.test(c);
}

/**
 * 開き引用符の位置から、閉じたあとの位置を返す。
 *
 * 引用符を2つ続けて書いたもの (`''`) は中身として読み飛ばす。
 * MySQLは `\'` でも逃がせるので、それも中身として扱う
 * (`` ` `` の中では逆斜線は逃がしにならない)
 */
function afterQuote(sql: string, at: number): number {
  const q = sql[at];
  let i = at + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "\\" && q !== "`") {
      i += 2;
      continue;
    }
    if (c === q) {
      if (sql[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  // 閉じていないときは、そこから先は全部中身とみなす
  return sql.length;
}

/** 整形にかける前に、名前を逃がす */
export function escapeKeywordFunctions(sql: string): Escaped {
  const names: string[] = [];
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    if (c === "'" || c === '"' || c === "`") {
      const end = afterQuote(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    if (wordStart(c)) {
      let j = i + 1;
      while (j < sql.length && wordChar(sql[j])) j++;
      const word = sql.slice(i, j);
      // 次に来るのが `(` のときだけ関数とみなす (`TRUNCATE TABLE t` は文のまま)
      let k = j;
      while (k < sql.length && /\s/.test(sql[k])) k++;
      if (sql[k] === "(" && KEYWORD_FUNCTIONS.includes(word.toLowerCase())) {
        out += MARK + names.length;
        names.push(word);
      } else {
        out += word;
      }
      i = j;
      continue;
    }

    out += c;
    i++;
  }
  return { sql: out, names };
}

/** 整形が済んだSQLの、逃がした名前を元に戻す */
export function restoreKeywordFunctions(sql: string, names: string[]): string {
  if (names.length === 0) return sql;
  return sql.replace(MARK_BACK, (whole, n: string) => {
    const name = names[Number(n)];
    return name === undefined ? whole : `${name}(`;
  });
}
