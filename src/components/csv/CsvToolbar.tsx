/**
 * CSVエディタのツールバー。
 *
 * 押せるかどうかの判断は全部 `active` から決まるので、
 * ウィンドウ本体から切り出してある。
 *
 * 並ぶのは絵だけ。何をする所かは、載せたときに出る吹き出しで伝える
 */
import { useMemo, useState } from "react";
import type {
  CsvInfo,
  CsvLayoutNode,
  CsvNameNode,
  CsvNameSet,
  CsvSavedLayout,
} from "../../types";
import { CsvFixedMenu } from "./CsvFixedMenu";
import { CsvNamesMenu } from "./CsvNamesMenu";
import { appliedNameSet } from "./csvNameSets";
import { appliedLayoutName } from "./csvFixed";
import { flatLayouts } from "./csvLayoutTree";
import {
  SaveIcon,
  SaveAsIcon,
  FindIcon,
  FilterIcon,
  CompareIcon,
  ExcelIcon,
  FixedIcon,
  NamesIcon,
  SplitIcon,
  SyncIcon,
} from "./CsvToolbarIcons";

interface Props {
  active: CsvInfo | null;
  onSave: (asNew: boolean) => void;
  /** Excel (.xlsx) として書き出す */
  onExcel: () => void;
  /** 表の検索・置換を開く */
  onFind: () => void;
  /** 見出しの絞り込みを使うか */
  filterOn: boolean;
  /** 絞り込みの入り切り */
  onToggleFilter: () => void;
  onCompare: () => void;
  /** 比較を始められるか (2つ以上開いているか) */
  canCompare: boolean;
  /** 左右に分けて出しているか */
  split: boolean;
  onToggleSplit: () => void;
  /** 分けているとき、スクロールを合わせるか */
  syncScroll: boolean;
  onToggleSync: () => void;
  /** お気に入りに登録した固定長の桁設定 (フォルダ分けと並び順のまま) */
  layouts: CsvLayoutNode[];
  /** お気に入りの桁設定で読み直す */
  onUseLayout: (s: CsvSavedLayout) => void;
  /** お気に入りの名前・桁設定を直す画面を開く */
  onEditLayout: (s: CsvSavedLayout) => void;
  /** お気に入りを削除する (確認の画面を出す) */
  onDeleteLayout: (s: CsvSavedLayout) => void;
  /** お気に入りの削除の確認を出しているか */
  deletingLayout: boolean;
  /** 並び順やフォルダ分けを変えた結果を残す */
  onSaveLayoutTree: (nodes: CsvLayoutNode[]) => void;
  /** 桁設定のダイアログを開く */
  onEditFixed: () => void;
  /** お気に入りのバックアップ・復元の画面を開く */
  onLayoutTransfer: (kind: "backup" | "restore") => void;
  /** 区切り文字として読み直す */
  onUseDelimiter: () => void;
  /** 列名のお気に入り (見出しの無いCSVに付ける列名の並び。フォルダ分けと並び順のまま) */
  nameSets: CsvNameNode[];
  /** お気に入りの列名を今のファイルに付ける */
  onUseNameSet: (s: CsvNameSet) => void;
  /** 今の列名をお気に入りに保存する画面を開く */
  onSaveNameSet: () => void;
  /** 列名のお気に入りを削除する (確認の画面を出す) */
  onDeleteNameSet: (s: CsvNameSet) => void;
  /** 列名のお気に入りの削除の確認を出しているか */
  deletingNameSet: boolean;
  /** 列名のお気に入りの並び順やフォルダ分けを変えた結果を残す */
  onSaveNameTree: (nodes: CsvNameNode[]) => void;
  /** 列名のお気に入りのバックアップ・復元の画面を開く */
  onNameTransfer: (kind: "backup" | "restore") => void;
}

export function CsvToolbar({
  active,
  onSave,
  onExcel,
  onFind,
  filterOn,
  onToggleFilter,
  onCompare,
  canCompare,
  split,
  onToggleSplit,
  syncScroll,
  onToggleSync,
  layouts,
  onUseLayout,
  onEditLayout,
  onDeleteLayout,
  deletingLayout,
  onSaveLayoutTree,
  onLayoutTransfer,
  onEditFixed,
  onUseDelimiter,
  nameSets,
  onUseNameSet,
  onSaveNameSet,
  onDeleteNameSet,
  deletingNameSet,
  onSaveNameTree,
  onNameTransfer,
}: Props) {
  /** 固定長のメニューを開いているか */
  const [fixedOpen, setFixedOpen] = useState(false);
  /** 列名のメニューを開いているか */
  const [namesOpen, setNamesOpen] = useState(false);
  const flatNames = useMemo(() => flatLayouts(nameSets), [nameSets]);
  const appliedNames =
    active && !active.hasHeader ? appliedNameSet(flatNames, active.labels) : null;
  /*
   * 読み方を変えられるのは、ファイルから開いたタブだけ。
   * お気に入りの整理はファイルが無くてもできるので、メニューそのものはいつでも開ける
   */
  const canApply = !!active?.path;
  /*
   * 今このファイルに使われているお気に入り。
   *
   * 覚えておくのではなく、今の桁設定と中身を見比べて求める
   * (取り消しや読み直しのあとでもずれない)
   */
  const flat = useMemo(() => flatLayouts(layouts), [layouts]);
  const applied = appliedLayoutName(flat, active?.format.fixed ?? null);

  return (
    <div className="csv-toolbar">
      <button
        className="pane-icon-btn has-tooltip tooltip-left"
        data-tooltip="保存 (⌘S)"
        disabled={!active?.dirty}
        onClick={() => onSave(false)}
      >
        <SaveIcon />
      </button>
      <button
        className="pane-icon-btn has-tooltip tooltip-left"
        data-tooltip="別名で保存 (⇧⌘S)"
        disabled={!active}
        onClick={() => onSave(true)}
      >
        <SaveAsIcon />
      </button>
      <button
        className="pane-icon-btn has-tooltip tooltip-left"
        data-tooltip="Excel (.xlsx) で書き出す"
        disabled={!active}
        onClick={onExcel}
      >
        <ExcelIcon />
      </button>

      <span className="csv-sep" />

      <div className="csv-fixed-wrap">
        <button
          className={
            "pane-icon-btn has-tooltip tooltip-left" +
            (active?.format.fixed ? " on" : "")
          }
          data-tooltip={applied ? `固定長設定: ${applied}` : "固定長設定"}
          onClick={() => setFixedOpen((v) => !v)}
        >
          <FixedIcon />
        </button>
        {fixedOpen && (
          <CsvFixedMenu
            canApply={canApply}
            fixed={canApply && !!active?.format.fixed}
            nodes={layouts}
            applied={applied}
            onUse={(s) => {
              setFixedOpen(false);
              onUseLayout(s);
            }}
            onEditItem={(s) => {
              setFixedOpen(false);
              onEditLayout(s);
            }}
            // 削除は確認の画面を挟む。どれを消すのか分かるよう、メニューは閉じない
            onDelete={onDeleteLayout}
            confirming={deletingLayout}
            onSaveTree={onSaveLayoutTree}
            onEdit={() => {
              setFixedOpen(false);
              onEditFixed();
            }}
            onBackup={() => {
              setFixedOpen(false);
              onLayoutTransfer("backup");
            }}
            onRestore={() => {
              setFixedOpen(false);
              onLayoutTransfer("restore");
            }}
            onUseDelimiter={() => {
              setFixedOpen(false);
              onUseDelimiter();
            }}
            onClose={() => setFixedOpen(false)}
          />
        )}
      </div>
      <div className="csv-fixed-wrap">
        <button
          className={
            "pane-icon-btn has-tooltip tooltip-left" + (appliedNames ? " on" : "")
          }
          data-tooltip={appliedNames ? `列名: ${appliedNames}` : "列名のお気に入り"}
          onClick={() => setNamesOpen((v) => !v)}
        >
          <NamesIcon />
        </button>
        {namesOpen && (
          <CsvNamesMenu
            active={active}
            nodes={nameSets}
            onUse={(s) => {
              setNamesOpen(false);
              onUseNameSet(s);
            }}
            onSave={() => {
              setNamesOpen(false);
              onSaveNameSet();
            }}
            // 削除は確認の画面を挟む。どれを消すのか分かるよう、メニューは閉じない
            onDelete={onDeleteNameSet}
            confirming={deletingNameSet}
            onSaveTree={onSaveNameTree}
            onBackup={() => {
              setNamesOpen(false);
              onNameTransfer("backup");
            }}
            onRestore={() => {
              setNamesOpen(false);
              onNameTransfer("restore");
            }}
            onClose={() => setNamesOpen(false)}
          />
        )}
      </div>

      <span className="csv-sep" />

      <button
        className="pane-icon-btn has-tooltip tooltip-left"
        data-tooltip="検索・置換 (⌘F)"
        disabled={!active}
        onClick={onFind}
      >
        <FindIcon />
      </button>
      <button
        className={
          "pane-icon-btn has-tooltip tooltip-left" + (filterOn ? " on" : "")
        }
        data-tooltip={
          filterOn ? "絞り込みをやめる" : "見出しから絞り込む (フィルタ)"
        }
        disabled={!active}
        onClick={onToggleFilter}
      >
        <FilterIcon />
      </button>
      <button
        className="pane-icon-btn has-tooltip tooltip-left"
        data-tooltip={canCompare ? "比較" : "比べるには2つ以上開いてください"}
        disabled={!canCompare}
        onClick={onCompare}
      >
        <CompareIcon />
      </button>

      <span className="csv-sep" />

      <button
        className={"pane-icon-btn has-tooltip tooltip-left" + (split ? " on" : "")}
        data-tooltip={split ? "分割をやめる" : "左右に分けて出す"}
        disabled={!active}
        onClick={onToggleSplit}
      >
        <SplitIcon />
      </button>
      {split && (
        <button
          className={
            "pane-icon-btn has-tooltip tooltip-left" + (syncScroll ? " on" : "")
          }
          data-tooltip={
            syncScroll ? "スクロールを合わせない" : "スクロールを合わせる"
          }
          onClick={onToggleSync}
        >
          <SyncIcon />
        </button>
      )}
    </div>
  );
}
