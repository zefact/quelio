/**
 * SQLエディタの中を探す・置き換える。
 *
 * 画面に出ている文字を探すページ内検索 (FindBar) とは別物。
 * こちらはエディタの本文そのものが相手なので、
 * 画面の外にある行も見つかるし、置き換えもできる。
 *
 * ここは文字列だけを扱い、CodeMirrorには触らない (試しやすくするため)。
 */

/** 探し方 */
export interface FindOptions {
  /** 大文字と小文字を区別する */
  caseSensitive: boolean;
  /** 単語として区切れている所だけを拾う */
  wholeWord: boolean;
  /** 正規表現として読む */
  regex: boolean;
}

/** 何も指定していないときの探し方 */
export const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/** 見つかった1か所 */
export interface FindHit {
  /** 始まり (文字数) */
  from: number;
  /** 終わり (文字数) */
  to: number;
  /** 正規表現の ( ) で取れた文字。前から順に並ぶ (取れなかった所は空) */
  groups: string[];
}

/** 置き換え1か所 */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * 一度に覚える上限。
 *
 * これを超えたぶんは数えない。数万件を色付けすると重くなるため
 */
export const MAX_HITS = 5000;

/**
 * 単語を作る文字か。
 *
 * 英数字と _ と $ だけを「単語の中身」とする。
 * 日本語は区切りが無いので単語の外として扱う
 * (「名」で探すと「名前」の中の「名」も単語として拾う)
 */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** 正規表現のはたらきを持つ文字を、ただの文字に戻す */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 探すための正規表現を組み立てる。
 *
 * 正規表現の書き方が壊れているとき (「(」だけ打った途中など) は null。
 * 画面はこれを見て「書き方が違います」と伝える
 */
export function buildMatcher(query: string, opts: FindOptions): RegExp | null {
  if (query === "") return null;
  const body = opts.regex ? query : escapeRegExp(query);
  try {
    return new RegExp(body, opts.caseSensitive ? "gm" : "gim");
  } catch {
    return null;
  }
}

/** 本文から、一致する所を前から順に全部拾う */
export function findAll(
  doc: string,
  query: string,
  opts: FindOptions
): FindHit[] {
  const re = buildMatcher(query, opts);
  if (!re) return [];

  const hits: FindHit[] = [];
  for (let m = re.exec(doc); m !== null; m = re.exec(doc)) {
    /*
     * 長さ0に一致する書き方 (^ や \b など) は、
     * そのままだと同じ所で止まり続けるので1文字ずらして先へ進む。
     * 長さ0の一致そのものは、色も付けられず置き換えようもないので拾わない
     */
    if (m[0] === "") {
      re.lastIndex += 1;
      if (re.lastIndex > doc.length) break;
      continue;
    }

    const from = m.index;
    const to = from + m[0].length;
    const bounded =
      !opts.wholeWord || (!isWordChar(doc[from - 1]) && !isWordChar(doc[to]));
    if (bounded) {
      hits.push({ from, to, groups: m.slice(1).map((g) => g ?? "") });
      if (hits.length >= MAX_HITS) break;
    }
  }
  return hits;
}

/** 今いる範囲 (エディタの選択) */
export interface Cursor {
  from: number;
  to: number;
}

/**
 * 今いる所が、ちょうど何番目の一致か。
 * 一致の上にいなければ -1
 */
export function indexAt(hits: FindHit[], cursor: Cursor): number {
  return hits.findIndex((h) => h.from === cursor.from && h.to === cursor.to);
}

/**
 * 今いる所から見て、次 (前) はどれか。
 *
 * 端まで来たら反対の端へ回る。1件も無ければ -1
 */
export function pickNext(
  hits: FindHit[],
  cursor: Cursor,
  forward: boolean
): number {
  if (hits.length === 0) return -1;
  if (forward) {
    const i = hits.findIndex((h) => h.from >= cursor.to);
    return i === -1 ? 0 : i;
  }
  for (let i = hits.length - 1; i >= 0; i--) {
    if (hits[i].to <= cursor.from) return i;
  }
  return hits.length - 1;
}

/**
 * 置き換える文字を組み立てる。
 *
 * 正規表現のときだけ、取れた文字を $1〜$9 で差し込める
 * ($& は一致した全体、$$ は $ そのもの)。
 * 正規表現でないときは打った文字をそのまま使う
 */
export function expandReplacement(
  replacement: string,
  hit: FindHit,
  doc: string,
  opts: FindOptions
): string {
  if (!opts.regex) return replacement;
  return replacement.replace(/\$(\$|&|\d)/g, (_all, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return doc.slice(hit.from, hit.to);
    const n = Number(key);
    return n >= 1 ? (hit.groups[n - 1] ?? "") : "";
  });
}

/** 1か所ぶんの置き換えを作る */
export function replaceOneChange(
  doc: string,
  hit: FindHit,
  replacement: string,
  opts: FindOptions
): TextChange {
  return {
    from: hit.from,
    to: hit.to,
    insert: expandReplacement(replacement, hit, doc, opts),
  };
}

/**
 * 全部ぶんの置き換えを作る。
 *
 * 前から順に並び、重なりも無いので、そのまままとめて適用できる
 */
export function replaceAllChanges(
  doc: string,
  query: string,
  replacement: string,
  opts: FindOptions
): TextChange[] {
  return findAll(doc, query, opts).map((h) =>
    replaceOneChange(doc, h, replacement, opts)
  );
}

/**
 * 置き換えたあとの本文 (試験と、まとめ置き換えの下ごしらえに使う)。
 * エディタ側はこれを使わず、差分だけを受け取る
 */
export function applyChanges(doc: string, changes: TextChange[]): string {
  let out = "";
  let at = 0;
  for (const c of changes) {
    out += doc.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + doc.slice(at);
}
