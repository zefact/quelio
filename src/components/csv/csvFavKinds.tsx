/**
 * お気に入りの種類 (固定長の桁設定・列名の並び) ごとの違い。
 *
 * バックアップ・復元の画面は同じものを使い、呼び名・ファイル名・大きさの単位・
 * 読み書きの関数だけをここで差し替える
 */
import type { ReactNode } from "react";
import {
  csvExportLayoutSubset,
  csvExportNameSubset,
  csvImportLayoutsAsNew,
  csvImportNamesAsNew,
  csvInspectLayoutFile,
  csvInspectNameFile,
} from "../../api";
import type {
  CsvLayoutFileEntry,
  CsvLayoutImported,
  CsvNameSet,
  CsvSavedLayout,
} from "../../types";
import { LayoutIcon, NameSetIcon } from "./CsvLayoutIcons";
import type { Named } from "./csvLayoutTree";

export interface FavKind<T extends Named> {
  /** 画面に出す呼び名 (「固定長のお気に入り」) */
  label: string;
  /** バックアップの既定のファイル名の頭 (`<頭>_20261005.json`) */
  filePrefix: string;
  /** 大きさの単位 (「桁」「列」) */
  unit: string;
  /** お気に入り1件の大きさ */
  sizeOf: (item: T) => number;
  /** 一覧で名前の前に出す絵 */
  icon: () => ReactNode;
  /** 選んだものだけをファイルへ書き出す (書き出した件数を返す) */
  exportSubset: (path: string, names: string[], folders: string[]) => Promise<number>;
  /** ファイルの中身と、取り込むときの名前を調べる */
  inspectFile: (path: string) => Promise<CsvLayoutFileEntry[]>;
  /** ファイルから選んだものを取り込む (今あるものは上書きしない) */
  importAsNew: (path: string, names: string[]) => Promise<CsvLayoutImported[]>;
}

/** 固定長の桁設定のお気に入り */
export const LAYOUT_KIND: FavKind<CsvSavedLayout> = {
  label: "固定長のお気に入り",
  filePrefix: "quelio_csv_layouts",
  unit: "桁",
  sizeOf: (s) => s.layout.columns.length,
  icon: () => <LayoutIcon />,
  exportSubset: csvExportLayoutSubset,
  inspectFile: csvInspectLayoutFile,
  importAsNew: csvImportLayoutsAsNew,
};

/** 列名の並びのお気に入り (見出しの無いCSV用) */
export const NAME_KIND: FavKind<CsvNameSet> = {
  label: "列名のお気に入り",
  filePrefix: "quelio_csv_names",
  unit: "列",
  sizeOf: (s) => s.columns.length,
  icon: () => <NameSetIcon />,
  exportSubset: csvExportNameSubset,
  inspectFile: csvInspectNameFile,
  importAsNew: csvImportNamesAsNew,
};
