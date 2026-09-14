import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIND_OPTIONS,
  applyChanges,
  buildMatcher,
  findAll,
  indexAt,
  pickNext,
  replaceAllChanges,
  replaceOneChange,
  type FindOptions,
} from "./sqlFind";

/** 既定の探し方に、変えたい所だけ足す */
function opts(patch: Partial<FindOptions> = {}): FindOptions {
  return { ...DEFAULT_FIND_OPTIONS, ...patch };
}

describe("findAll", () => {
  it("大文字小文字を問わずに拾う", () => {
    const hits = findAll("select ID from Users", "id", opts());
    expect(hits.map((h) => [h.from, h.to])).toEqual([[7, 9]]);
  });

  it("区別する指定なら、そのままの綴りだけ", () => {
    const doc = "select ID, id from t";
    expect(findAll(doc, "id", opts({ caseSensitive: true })).length).toBe(1);
    expect(findAll(doc, "id", opts()).length).toBe(2);
  });

  it("空の検索語は0件", () => {
    expect(findAll("select 1", "", opts())).toEqual([]);
  });

  it("単語だけの指定なら、くっついている所は拾わない", () => {
    const doc = "id, uuid, user_id, id2";
    const all = findAll(doc, "id", opts());
    const word = findAll(doc, "id", opts({ wholeWord: true }));
    expect(all.length).toBe(4);
    // 先頭の id だけが単語として区切れている
    expect(word.map((h) => h.from)).toEqual([0]);
  });

  it("日本語は区切りが無いので、単語指定でも中身が拾える", () => {
    const hits = findAll("氏名前", "名", opts({ wholeWord: true }));
    expect(hits.map((h) => h.from)).toEqual([1]);
  });

  it("正規表現でないときは記号もそのままの文字として探す", () => {
    const hits = findAll("a.b axb", "a.b", opts());
    expect(hits.map((h) => h.from)).toEqual([0]);
  });

  it("正規表現の指定なら記号がはたらく", () => {
    const hits = findAll("a.b axb", "a.b", opts({ regex: true }));
    expect(hits.map((h) => h.from)).toEqual([0, 4]);
  });

  it("正規表現の ( ) で取れた文字を持って帰る", () => {
    const hits = findAll("col_a, col_b", "col_(\\w)", opts({ regex: true }));
    expect(hits.map((h) => h.groups[0])).toEqual(["a", "b"]);
  });

  it("長さ0に一致する書き方でも止まらない", () => {
    // ^ は行頭に長さ0で一致する。拾わずに先へ進むだけ
    expect(findAll("a\nb\nc", "^", opts({ regex: true }))).toEqual([]);
  });

  it("壊れた正規表現は0件 (例外にしない)", () => {
    expect(findAll("abc", "(", opts({ regex: true }))).toEqual([]);
    expect(buildMatcher("(", opts({ regex: true }))).toBeNull();
  });

  it("^ と $ は行ごとに効く", () => {
    const hits = findAll("aa\nab", "^a.", opts({ regex: true }));
    expect(hits.map((h) => h.from)).toEqual([0, 3]);
  });
});

describe("pickNext / indexAt", () => {
  const doc = "id a id b id";
  const hits = findAll(doc, "id", opts());

  it("カーソルの後ろにある最初の一致へ進む", () => {
    expect(pickNext(hits, { from: 0, to: 2 }, true)).toBe(1);
  });

  it("末尾まで行ったら先頭へ回る", () => {
    expect(pickNext(hits, { from: 10, to: 12 }, true)).toBe(0);
  });

  it("前へ戻るときは、カーソルの手前にある最後の一致", () => {
    expect(pickNext(hits, { from: 10, to: 12 }, false)).toBe(1);
  });

  it("先頭より前は末尾へ回る", () => {
    expect(pickNext(hits, { from: 0, to: 0 }, false)).toBe(2);
  });

  it("1件も無ければ -1", () => {
    expect(pickNext([], { from: 0, to: 0 }, true)).toBe(-1);
  });

  it("ちょうど一致の上にいれば、その番号が分かる", () => {
    expect(indexAt(hits, { from: 5, to: 7 })).toBe(1);
    expect(indexAt(hits, { from: 4, to: 7 })).toBe(-1);
  });
});

describe("置き換え", () => {
  it("1か所だけ置き換える", () => {
    const doc = "select id from t";
    const hit = findAll(doc, "id", opts())[0];
    const change = replaceOneChange(doc, hit, "code", opts());
    expect(applyChanges(doc, [change])).toBe("select code from t");
  });

  it("全部まとめて置き換える", () => {
    const doc = "id, id, id";
    const changes = replaceAllChanges(doc, "id", "no", opts());
    expect(changes.length).toBe(3);
    expect(applyChanges(doc, changes)).toBe("no, no, no");
  });

  it("正規表現でないときは $1 もただの文字", () => {
    const doc = "aaa";
    expect(applyChanges(doc, replaceAllChanges(doc, "a", "$1", opts()))).toBe(
      "$1$1$1"
    );
  });

  it("正規表現なら $1 に取れた文字が入る", () => {
    const doc = "col_a, col_b";
    const changes = replaceAllChanges(
      doc,
      "col_(\\w)",
      "\"$1\"",
      opts({ regex: true })
    );
    expect(applyChanges(doc, changes)).toBe('"a", "b"');
  });

  it("$& は一致した全体、$$ は $ そのもの", () => {
    const doc = "abc";
    const changes = replaceAllChanges(doc, "b", "[$&]$$", opts({ regex: true }));
    expect(applyChanges(doc, changes)).toBe("a[b]$c");
  });

  it("長さの変わる置き換えでも、後ろの位置がずれない", () => {
    const doc = "x id y id z";
    const changes = replaceAllChanges(doc, "id", "identifier", opts());
    expect(applyChanges(doc, changes)).toBe("x identifier y identifier z");
  });

  it("置き換え先が空なら消える", () => {
    const doc = "a, b, c";
    expect(applyChanges(doc, replaceAllChanges(doc, ", ", "", opts()))).toBe(
      "abc"
    );
  });
});
