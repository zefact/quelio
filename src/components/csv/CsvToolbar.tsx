/**
 * CSVエディタのツールバー。
 *
 * 押せるかどうかの判断は全部 `active` から決まるので、
 * ウィンドウ本体から切り出してある。
 *
 * 並ぶのは絵だけ。何をする所かは、載せたときに出る吹き出しで伝える
 */
import type { CsvInfo } from "../../types";
import {
  SaveIcon,
  SaveAsIcon,
  FindIcon,
  CompareIcon,
  ExcelIcon,
  SplitIcon,
  SyncIcon,
} from "./CsvToolbarIcons";

interface Props {
  active: CsvInfo | null;
  onSave: (asNew: boolean) => void;
  /** Excel (.xlsx) として書き出す */
  onExcel: () => void;
  onFind: () => void;
  onCompare: () => void;
  /** 比較を始められるか (2つ以上開いているか) */
  canCompare: boolean;
  /** 左右に分けて出しているか */
  split: boolean;
  onToggleSplit: () => void;
  /** 分けているとき、スクロールを合わせるか */
  syncScroll: boolean;
  onToggleSync: () => void;
}

export function CsvToolbar({
  active,
  onSave,
  onExcel,
  onFind,
  onCompare,
  canCompare,
  split,
  onToggleSplit,
  syncScroll,
  onToggleSync,
}: Props) {
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

      <button
        className="pane-icon-btn has-tooltip tooltip-left"
        data-tooltip="検索・置換 (⌘F)"
        disabled={!active}
        onClick={onFind}
      >
        <FindIcon />
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
