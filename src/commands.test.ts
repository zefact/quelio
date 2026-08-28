import { describe, expect, it } from "vitest";
import { COMMAND_NAMES } from "./commands";
// Rust側の登録をそのまま読む (?raw はViteが中身を文字列で渡す)
import libRs from "../src-tauri/src/lib.rs?raw";

/**
 * 画面から呼べるコマンドの一覧が、Rust側の登録と一致しているかを見る。
 *
 * 名前は文字列で渡すので、Rust側で消したり改名したりしても
 * TypeScriptだけでは気づけない (動かして初めて「コマンドが無い」と出る)。
 * lib.rs の invoke_handler と突き合わせて、ここで落ちるようにしておく
 */
function rustCommands(): string[] {
  const start = libRs.indexOf("generate_handler!");
  expect(start, "invoke_handler の登録が見つかりません").toBeGreaterThan(0);
  const end = libRs.indexOf("])", start);
  const block = libRs.slice(start, end);
  return [...block.matchAll(/commands::(\w+)/g)].map((m) => m[1]);
}

describe("コマンドの一覧", () => {
  it("Rust側の登録と過不足なく一致する", () => {
    const rust = rustCommands();
    const ts: string[] = [...COMMAND_NAMES];
    // 片側にしか無いものを名前で出す (どちらを直すか分かるように)
    expect(ts.filter((c) => !rust.includes(c))).toEqual([]);
    expect(rust.filter((c) => !ts.includes(c))).toEqual([]);
  });

  it("同じ名前を二重に並べていない", () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
  });
});
