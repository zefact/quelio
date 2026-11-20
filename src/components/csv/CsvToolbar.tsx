/**
 * CSVエディタのツールバー。
 *
 * 押せるかどうかの判断は全部 `active` から決まるので、
 * ウィンドウ本体から切り出してある。
 *
 * 並ぶのは絵だけ。何をする所かは、載せたときに出る吹き出しで伝える
 * (読み上げにも同じ文が届くよう、IconButton を使う)
 */
import { useMemo, useState } from "react";
import { MOD, SHIFT } from "../../keyLabel";
import { IconButton } from "../IconButton";
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
  OpenIcon,
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
  /** ファイルを選んで開く (⌘O と同じ) */
  onOpen: () => void;
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
  onOpen,
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
      <IconButton
        className="pane-icon-btn"
        tipLeft
        label={`ファイルを開く (${MOD}O)`}
        onClick={onOpen}
      >
        <OpenIcon />
      </IconButton>
      <IconButton
        className="pane-icon-btn"
        tipLeft
        label={
          active && !active.dirty
            ? `保存 (${MOD}S)\n変更が無いので保存するものはありません`
            : `保存 (${MOD}S)`
        }
        disabled={!active?.dirty}
        onClick={() => onSave(false)}
      >
        <SaveIcon />
      </IconButton>
      <IconButton
        className="pane-icon-btn"
        tipLeft
        label={`別名で保存 (${SHIFT}${MOD}S)`}
        disabled={!active}
        onClick={() => onSave(true)}
      >
        <SaveAsIcon />
      </IconButton>
      <IconButton
        className="pane-icon-btn"
        tipLeft
        label="Excel (.xlsx) で書き出す"
        disabled={!active}
        onClick={onExcel}
      >
        <ExcelIcon />
      </IconButton>

      <span className="csv-sep" />

      <div className="csv-fixed-wrap">
        <IconButton
          className={"pane-icon-btn" + (active?.format.fixed ? " on" : "")}
          tipLeft
          label={applied ? `固定長設定: ${applied}` : "固定長設定"}
          aria-expanded={fixedOpen}
          onClick={() => setFixedOpen((v) => !v)}
        >
          <FixedIcon />
        </IconButton>
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
        <IconButton
          className={"pane-icon-btn" + (appliedNames ? " on" : "")}
          tipLeft
          label={appliedNames ? `列名: ${appliedNames}` : "列名のお気に入り"}
          aria-expanded={namesOpen}
          onClick={() => setNamesOpen((v) => !v)}
        >
          <NamesIcon />
        </IconButton>
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

      <IconButton
        className="pane-icon-btn"
        tipLeft
        label={`検索・置換 (${MOD}F)`}
        disabled={!active}
        onClick={onFind}
      >
        <FindIcon />
      </IconButton>
      <IconButton
        className={"pane-icon-btn" + (filterOn ? " on" : "")}
        tipLeft
        label={filterOn ? "絞り込みをやめる" : "見出しから絞り込む"}
        aria-pressed={filterOn}
        disabled={!active}
        onClick={onToggleFilter}
      >
        <FilterIcon />
      </IconButton>
      <IconButton
        className="pane-icon-btn"
        tipLeft
        label={
          canCompare ? "2つのファイルを比較" : "比較するには2つ以上開いてください"
        }
        disabled={!canCompare}
        onClick={onCompare}
      >
        <CompareIcon />
      </IconButton>

      <span className="csv-sep" />

      <IconButton
        className={"pane-icon-btn" + (split ? " on" : "")}
        tipLeft
        label={split ? "分割をやめる" : "左右に分けて出す"}
        aria-pressed={split}
        disabled={!active}
        onClick={onToggleSplit}
      >
        <SplitIcon />
      </IconButton>
      {split && (
        <IconButton
          className={"pane-icon-btn" + (syncScroll ? " on" : "")}
          tipLeft
          label={syncScroll ? "スクロールを合わせない" : "スクロールを合わせる"}
          aria-pressed={syncScroll}
          onClick={onToggleSync}
        >
          <SyncIcon />
        </IconButton>
      )}
    </div>
  );
}
