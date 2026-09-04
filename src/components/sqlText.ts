/**
 * SQLを文字として扱うための小道具。
 *
 * 補完はSQLを構文解析せずに「今いる場所の前後」を見て判断している。
 * その判断がコメントや文字列の中身に振り回されないよう、
 * ここに「読み飛ばす」「同じ位置のまま隠す」道具をまとめる
 */

/** 識別子 (バッククォート・ダブルクォート囲みも許す) */
export const ID_SOURCE = '(?:[A-Za-z_$#][\\w$#]*|`[^`]*`|"[^"]*")';

const IDENT_HEAD = new RegExp(`^${ID_SOURCE}`);
const WORD_HEAD = /^[A-Za-z_$#][\w$#]*/;

/** クォートを外す */
export function unquote(name: string): string {
  const s = name.trim();
  const q = s[0];
  if ((q === "`" || q === '"') && s.length >= 2 && s.endsWith(q)) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * コメントと文字列を空白に置き換えた文字列を作る。
 *
 * 長さと改行の位置はそのままなので、ここで見つけた位置は
 * 元のSQLの位置としてそのまま使える。
 * (MySQLの `#` コメントは、SQL Serverの `#tmp` と区別が付かないので触らない)
 */
export function mask(sql: string): string {
  const out = sql.split("");
  const blank = (at: number) => {
    if (out[at] !== "\n") out[at] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") blank(i++);
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      while (i < stop) blank(i++);
    } else if (c === "'") {
      blank(i++);
      while (i < sql.length) {
        if (sql[i] === "'") {
          blank(i++);
          // '' は文字としての ' なので、まだ文字列の中
          if (sql[i] === "'") {
            blank(i++);
            continue;
          }
          break;
        }
        blank(i++);
      }
    } else {
      i++;
    }
  }
  return out.join("");
}

/** 空白を飛ばした次の位置 */
export function skipWs(masked: string, at: number): number {
  let i = at;
  while (i < masked.length && /\s/.test(masked[i])) i++;
  return i;
}

/** open の位置の `(` に対応する `)` の位置 (見つからなければ -1) */
export function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 読み取った文字列とその終わり */
export interface Token {
  text: string;
  end: number;
}

/** その位置から始まる語 (クォート無しの英数字) */
export function readWord(masked: string, at: number): Token | null {
  const m = WORD_HEAD.exec(masked.slice(at));
  return m ? { text: m[0], end: at + m[0].length } : null;
}

/** その位置から始まる識別子 (クォート囲みも読む) */
export function readIdent(
  masked: string,
  text: string,
  at: number
): Token | null {
  const m = IDENT_HEAD.exec(masked.slice(at));
  if (!m) return null;
  // 中身はクォートに隠されていないので、元のSQLから取り直す
  return { text: text.slice(at, at + m[0].length), end: at + m[0].length };
}

/** `schema.table` のような、ドットでつないだ識別子 */
export function readQualified(
  masked: string,
  text: string,
  at: number
): Token | null {
  let head = readIdent(masked, text, at);
  if (!head) return null;
  for (;;) {
    const dot = skipWs(masked, head.end);
    if (masked[dot] !== ".") break;
    const next = readIdent(masked, text, skipWs(masked, dot + 1));
    if (!next) break;
    head = { text: text.slice(at, next.end), end: next.end };
  }
  return head;
}

/** いちばん外側のカンマで区切った範囲 (括弧の中のカンマは無視する) */
export function splitTop(
  masked: string,
  from: number,
  to: number
): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, to]);
  return out;
}

/**
 * いちばん外側にある語を順に返す。
 *
 * 括弧の中は飛ばすので、`from (select ...) x` の中の `select` は出てこない
 */
export function* topWords(
  masked: string,
  from: number,
  to: number
): Generator<Token> {
  let depth = 0;
  let i = from;
  while (i < to) {
    const c = masked[i];
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      i++;
      continue;
    }
    if (depth !== 0 || !/[A-Za-z_$#]/.test(c)) {
      i++;
      continue;
    }
    // 語の途中から拾わない (`from` と `xfrom` を区別する)
    if (i > from && /[\w$#]/.test(masked[i - 1])) {
      i++;
      continue;
    }
    const w = readWord(masked, i);
    if (!w) {
      i++;
      continue;
    }
    yield w;
    i = w.end;
  }
}
