import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_CSV_IMPORT,
  closeCsvImport,
  csvImportStore,
  openCsvImport,
  patchCsvImportForm,
} from "./csvImportStore";
import type { TableInfo } from "./types";

const users = { name: "users", tableType: "BASE TABLE" } as TableInfo;

describe("csvImportStore", () => {
  beforeEach(() => csvImportStore.reset());

  it("開くと対象が入り、前回の内容は残らない", () => {
    openCsvImport("tab-0", users);
    patchCsvImportForm("tab-0", { mode: "replace" });
    openCsvImport("tab-0", users);
    expect(csvImportStore.get("tab-0").target).toEqual(users);
    expect(csvImportStore.get("tab-0").form.mode).toBe("append");
  });

  it("タブごとに別々に持つ", () => {
    openCsvImport("tab-0", users);
    expect(csvImportStore.get("tab-1")).toBe(EMPTY_CSV_IMPORT);
  });

  it("閉じると消える", () => {
    openCsvImport("tab-0", users);
    closeCsvImport("tab-0");
    expect(csvImportStore.get("tab-0").target).toBeNull();
  });

  it("取り込み中は閉じない (裏で続く処理を見失わないため)", () => {
    openCsvImport("tab-0", users);
    csvImportStore.patch("tab-0", {
      job: { id: "csvin-1", startedAt: 1 },
    });
    closeCsvImport("tab-0");
    expect(csvImportStore.get("tab-0").target).toEqual(users);
  });

  it("フォームだけを書き換えられる", () => {
    openCsvImport("tab-0", users);
    patchCsvImportForm("tab-0", { mapping: ["id", null] });
    const state = csvImportStore.get("tab-0");
    expect(state.form.mapping).toEqual(["id", null]);
    expect(state.form.emptyAsNull).toBe(true);
    expect(state.target).toEqual(users);
  });
});
