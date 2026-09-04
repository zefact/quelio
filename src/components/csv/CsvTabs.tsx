import type { CsvInfo } from "../../types";
import { isBetaVersion, useAppVersion } from "../../hooks/useAppVersion";
import { CsvIcon } from "../CsvIcon";
import { DbIcon } from "../DbIcon";

interface Props {
  tabs: CsvInfo[];
  /** 触っている側の窓に出しているファイル */
  activeId: string | null;
  /** 左右に分けて出しているか */
  split?: boolean;
  /** 左側・右側に出しているファイル (分けているときだけ印を付ける) */
  leftId?: string | null;
  rightId?: string | null;
  onSelect: (docId: string) => void;
  onClose: (tab: CsvInfo) => void;
  /** タブを右クリックした (まとめて閉じるメニューを出す) */
  onMenu: (tab: CsvInfo, x: number, y: number) => void;
  onAdd: () => void;
  /** DBの画面を前に出す (閉じていれば開き直す) */
  onOpenDb: () => void;
  onOpenSettings: () => void;
}

/**
 * CSVウィンドウの中のタブ。
 *
 * 未保存のものは名前の左に点を出す (閉じるボタンと入れ替えず、
 * 「閉じられる」ことと「未保存である」ことを別に見せる)。
 *
 * 並びと右端のアイコンは、DBの画面のタブ列と同じ形にしてある
 */
/** そのファイルを出している側 (出していなければ null) */
function sideMark(
  docId: string,
  leftId: string | null,
  rightId: string | null
): string | null {
  const l = docId === leftId;
  const r = docId === rightId;
  if (l && r) return "左右";
  if (l) return "左";
  if (r) return "右";
  return null;
}

export function CsvTabs({
  tabs,
  activeId,
  split = false,
  leftId = null,
  rightId = null,
  onSelect,
  onClose,
  onMenu,
  onAdd,
  onOpenDb,
  onOpenSettings,
}: Props) {
  const isBeta = isBetaVersion(useAppVersion());
  return (
    <div className="csv-tabs" data-tauri-drag-region>
      {/* DBのウィンドウと同じ位置に名乗りを置く (どのウィンドウか一目で分かるように) */}
      <div className="brand" title="QuelioCSV" data-tauri-drag-region>
        <span className="brand-mark csv-mark">
          <CsvIcon />
        </span>
        <span className="brand-name">QuelioCSV</span>
        {isBeta && <span className="beta-badge">β</span>}
      </div>

      {/*
        タブだけを横スクロールさせる (DBの画面と同じ作り)。
        列全体をスクロールさせると、右端のアイコンのヒントが
        はみ出し隠しで切られて読めなくなる
      */}
      <div className="csv-tabs-list">
        {tabs.map((t) => (
          <div
            key={t.docId}
            className={
              "csv-tab" +
              (t.docId === activeId ? " active" : "") +
              // 分割の相方は、触っている側より控えめに印を付ける
              (t.docId !== activeId && t.docId === rightId ? " side" : "") +
              (t.docId !== activeId && t.docId === leftId ? " side" : "")
            }
            onMouseDown={() => onSelect(t.docId)}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(t, e.clientX, e.clientY);
            }}
            title={t.path ?? t.name}
          >
            {/* 左右のどちら側に出しているかを、名前の前に小さく出す */}
            {split && sideMark(t.docId, leftId, rightId) && (
              <span className="csv-tab-side">
                {sideMark(t.docId, leftId, rightId)}
              </span>
            )}
            {t.dirty && <span className="csv-tab-dot" aria-label="未保存" />}
            <span className="csv-tab-name">{t.name}</span>
            <button
              className="csv-tab-close"
              title="閉じる"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="tab-add" title="新しいCSV" onClick={onAdd}>
        +
      </button>

      {/* 余った所を掴んでウィンドウを動かせるようにする */}
      <span className="csv-tabs-drag" data-tauri-drag-region />

      {/*
        右端のアイコンはDBの画面と同じ並び。
        CSVエディタだけを残してDBの画面を閉じても、ここから戻れる
      */}
      <button
        className="console-btn has-tooltip"
        data-tooltip="QuelioDB (閉じていれば開き直します)"
        onClick={onOpenDb}
      >
        <DbIcon />
      </button>
      <button
        className="console-btn has-tooltip"
        data-tooltip="設定"
        onClick={onOpenSettings}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M19.4 13.5a7.6 7.6 0 000-3l2-1.2-2-3.4-2.3 1a7.6 7.6 0 00-2.6-1.5L14.2 3h-4l-.4 2.4a7.6 7.6 0 00-2.6 1.5l-2.3-1-2 3.4 2 1.2a7.6 7.6 0 000 3l-2 1.2 2 3.4 2.3-1a7.6 7.6 0 002.6 1.5l.4 2.4h4l.3-2.4a7.6 7.6 0 002.6-1.5l2.3 1 2-3.4z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
