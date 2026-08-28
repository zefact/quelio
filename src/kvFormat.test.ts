import { describe, expect, it } from "vitest";
import { tryFormatValue } from "./kvFormat";

describe("tryFormatValue: JSON", () => {
  it("整形して返す", () => {
    expect(tryFormatValue('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(tryFormatValue("[1,2]")).toBe("[\n  1,\n  2\n]");
  });

  it("入れ子のJSON文字列も展開する", () => {
    const out = tryFormatValue('{"a":"{\\"b\\":1}"}');
    expect(JSON.parse(out ?? "")).toEqual({ a: { b: 1 } });
  });

  it("JSONでなければnull", () => {
    expect(tryFormatValue("ただの文字列")).toBeNull();
    expect(tryFormatValue("{壊れている")).toBeNull();
    expect(tryFormatValue("")).toBeNull();
  });
});

describe("tryFormatValue: PHPシリアライズ", () => {
  it("配列を展開する", () => {
    const out = tryFormatValue('a:2:{i:0;s:1:"a";i:1;i:2;}');
    expect(JSON.parse(out ?? "")).toEqual(["a", 2]);
  });

  it("連想配列はオブジェクトにする", () => {
    const out = tryFormatValue('a:1:{s:3:"key";s:5:"value";}');
    expect(JSON.parse(out ?? "")).toEqual({ key: "value" });
  });

  it("真偽値・NULL・小数を扱う", () => {
    expect(JSON.parse(tryFormatValue("b:1;") ?? "")).toBe(true);
    expect(JSON.parse(tryFormatValue("N;") ?? "")).toBeNull();
    expect(JSON.parse(tryFormatValue("d:1.5;") ?? "")).toBe(1.5);
  });

  it("文字列長はバイト数で数える (日本語)", () => {
    // "あ" はUTF-8で3バイト
    const out = tryFormatValue('a:1:{s:3:"あ";s:6:"かき";}');
    expect(JSON.parse(out ?? "")).toEqual({ あ: "かき" });
  });

  it("入れ子のシリアライズ文字列も展開する (セッション想定)", () => {
    const inner = 'a:1:{s:1:"b";i:1;}';
    const outer = `a:1:{s:1:"a";s:${inner.length}:"${inner}";}`;
    expect(JSON.parse(tryFormatValue(outer) ?? "")).toEqual({ a: { b: 1 } });
  });

  it("オブジェクトはクラス名を残す", () => {
    const out = tryFormatValue('O:3:"Foo":1:{s:1:"a";i:1;}');
    expect(JSON.parse(out ?? "")).toEqual({ "(class)": "Foo", a: 1 });
  });

  it("途中で終わっている・余りがあるものは受け付けない", () => {
    expect(tryFormatValue('a:2:{i:0;s:1:"a";')).toBeNull();
    expect(tryFormatValue("i:1;ゴミ")).toBeNull();
    expect(tryFormatValue('s:5:"ab";')).toBeNull();
  });
});
