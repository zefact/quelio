import { afterEach, describe, expect, it } from "vitest";
import {
  formatLabel,
  isTextFormat,
  lastErFormat,
  rememberErFormat,
} from "./exportFormat";

/** テスト環境の localStorage を簡易に用意する */
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
});

afterEach(() => store.clear());

describe("ER図の書き出し形式", () => {
  it("初めてはPNG、選んだ形式を次の既定にする", () => {
    expect(lastErFormat()).toBe("png");
    rememberErFormat("xlsx");
    expect(lastErFormat()).toBe("xlsx");
  });

  it("知らない値が入っていたらPNGに戻す", () => {
    store.set("quelio.erExportFormat", "pdf");
    expect(lastErFormat()).toBe("png");
  });

  it("テキスト形式だけコピーできる", () => {
    expect(isTextFormat("mermaid")).toBe(true);
    expect(isTextFormat("svg")).toBe(true);
    expect(isTextFormat("png")).toBe(false);
    expect(isTextFormat("xlsx")).toBe(false);
    expect(formatLabel("plantuml")).toBe("PlantUML");
  });
});
