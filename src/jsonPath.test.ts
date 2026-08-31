import { describe, expect, it } from "vitest";
import { childPath, indexPath, ROOT_PATH } from "./jsonPath";

describe("JSONのパス", () => {
  it("英数字のキーはそのまま繋ぐ", () => {
    expect(childPath(ROOT_PATH, "name")).toBe("$.name");
    expect(childPath("$.user", "first_name2")).toBe("$.user.first_name2");
  });

  it("数字から始まるキーや記号を含むキーは引用符で囲む", () => {
    expect(childPath(ROOT_PATH, "1st")).toBe('$."1st"');
    expect(childPath(ROOT_PATH, "商品 名")).toBe('$."商品 名"');
    expect(childPath(ROOT_PATH, "a-b")).toBe('$."a-b"');
    expect(childPath(ROOT_PATH, "")).toBe('$.""');
  });

  it("引用符とバックスラッシュをエスケープする", () => {
    expect(childPath(ROOT_PATH, 'a"b')).toBe('$."a\\"b"');
    expect(childPath(ROOT_PATH, "a\\b")).toBe('$."a\\\\b"');
  });

  it("配列は位置を角括弧で書く", () => {
    expect(indexPath(ROOT_PATH, 0)).toBe("$[0]");
    expect(indexPath("$.items", 12)).toBe("$.items[12]");
  });

  it("入れ子を繋げられる", () => {
    expect(childPath(indexPath(childPath(ROOT_PATH, "items"), 2), "name")).toBe(
      "$.items[2].name"
    );
  });
});
