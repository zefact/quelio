import type { QuerySheet, TabTableData } from "../types";

/**
 * App → SessionView → TableView → TableDataView と
 * そのまま渡されるだけだった「データタブ」の状態と操作をまとめたもの。
 *
 * 途中の画面は中身を見ないので、1つの塊で受け渡す
 */
export interface TableDataPane extends TabTableData {
  onChangeWhere: (where: string) => void;
  /** 絞り込みを適用して先頭ページから取得し直す */
  /**
   * 条件を適用して先頭ページから取り直す。
   * whereを渡すとその条件で取る (画面の状態が反映されるのを待たずに済む)
   */
  onApplyWhere: (where?: string) => void;
  /** 表示中のページを取得し直す */
  onReload: () => void;
  onPage: (offset: number) => void;
  onSort: (orderBy: string | null, orderDir: "asc" | "desc") => void;
}

/**
 * App → SessionView → QueryPanel と素通しになる
 * SQLのシート (タブ) の状態と操作
 */
export interface SheetPane {
  sheets: QuerySheet[];
  /** 表示中のシートのID */
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
}
