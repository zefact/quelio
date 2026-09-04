import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_CSV_EXPORT,
  dropCsvExport,
  getCsvExport,
  patchCsvExport,
  resetCsvExportStore,
  subscribeCsvExport,
} from "./csvExportStore";

describe("csvExportStore", () => {
  beforeEach(() => resetCsvExportStore());

  it("知らないキーは毎回同じ「空」を返す", () => {
    // 参照が変わると、画面が更新され続けてしまう
    expect(getCsvExport("a")).toBe(EMPTY_CSV_EXPORT);
    expect(getCsvExport("a")).toBe(getCsvExport("b"));
  });

  it("書き換えた分だけ変わる", () => {
    const job = { id: "csv-1", index: 0, startedAt: 100, verb: "出力" };
    patchCsvExport("a", { job });
    patchCsvExport("a", { path: "/tmp/out.csv" });
    expect(getCsvExport("a")).toEqual({
      job,
      message: null,
      path: "/tmp/out.csv",
    });
  });

  it("キーごとに別々に持つ", () => {
    patchCsvExport("a", {
      job: { id: "csv-1", index: 0, startedAt: 1, verb: "出力" },
    });
    expect(getCsvExport("b").job).toBeNull();
  });

  it("変化を知らせる (解除したら来ない)", () => {
    const seen = vi.fn();
    const off = subscribeCsvExport("a", seen);
    patchCsvExport("a", { path: "/tmp/1.csv" });
    // 別のキーの変化では呼ばれない
    patchCsvExport("b", { path: "/tmp/2.csv" });
    off();
    patchCsvExport("a", { path: "/tmp/3.csv" });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("捨てると空に戻る", () => {
    patchCsvExport("a", { path: "/tmp/1.csv" });
    dropCsvExport("a");
    expect(getCsvExport("a")).toBe(EMPTY_CSV_EXPORT);
  });
});
