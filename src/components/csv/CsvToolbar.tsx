/**
 * CSVエディタのツールバー。
 *
 * 押せるかどうかの判断は全部 `active` から決まるので、
 * ウィンドウ本体から切り出してある。
 *
 * 並ぶのは絵だけ。何をする所かは、載せたときに出る吹き出しで伝える
 */
import { useState } from "react";
import type { CsvInfo, CsvSavedLayout } from "../../types";
import { CsvFixedMenu } from "./CsvFixedMenu";
import { appliedLayoutName } from "./csvFixed";
import {
  SaveIcon,
  SaveAsIcon,
  FindIcon,
  FilterIcon,
  CompareIcon,
  ExcelIcon,
  FixedIcon,
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
  /** お気に入りに登録した固定長の桁設定 */
  layouts: CsvSavedLayout[];
  /** お気に入りの桁設定で読み直す */
  onUseLayout: (s: CsvSavedLayout) => void;
  /** お気に入りを削除する */
  onDeleteLayout: (s: CsvSavedLayout) => void;
  /** 桁設定のダイアログを開く */
  onEditFixed: () => void;
  /** 区切り文字として読み直す */
  onUseDelimiter: () => void;
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
  onDeleteLayout,
  onEditFixed,
  onUseDelimiter,
}: Props) {
  /** 固定長のメニューを開いているか */
  const [fixedOpen, setFixedOpen] = useState(false);
  // 読み方を変えられるのは、ファイルから開いたタブだけ
  const canFixed = !!active?.path;
  /*
   * 今このファイルに使われているお気に入り。
   *
   * 覚えておくのではなく、今の桁設定と中身を見比べて求める
   * (取り消しや読み直しのあとでもずれない)
   */
  const applied = appliedLayoutName(layouts, active?.format.fixed ?? null);

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
          data-tooltip={
            canFixed
              ? applied
                ? `固定長: ${applied}`
                : active?.format.fixed
                  ? "固定長の桁設定を変更"
                  : "固定長として読み直す"
              : "ファイルから開いたタブのみ読み方を変更できます"
          }
          disabled={!canFixed}
          onClick={() => setFixedOpen((v) => !v)}
        >
          <FixedIcon />
        </button>
        {fixedOpen && active && (
          <CsvFixedMenu
            fixed={!!active.format.fixed}
            layouts={layouts}
            applied={applied}
            onUse={(s) => {
              setFixedOpen(false);
              onUseLayout(s);
            }}
            onDelete={(s) => {
              setFixedOpen(false);
              onDeleteLayout(s);
            }}
            onEdit={() => {
              setFixedOpen(false);
              onEditFixed();
            }}
            onUseDelimiter={() => {
              setFixedOpen(false);
              onUseDelimiter();
            }}
            onClose={() => setFixedOpen(false)}
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
