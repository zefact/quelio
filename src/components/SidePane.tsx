/**
 * 左ペインの枠 (幅の変更つき)。
 *
 * テーブル一覧 (SessionView) とキー一覧 (KvSessionView) は
 * 中身こそ違うが、枠と幅の変え方は同じ。
 * 枠だけをここに置き、中身はそれぞれの画面が渡す
 */
import type { ReactNode } from "react";

/** 矢印キー1回で動かす幅 (Shiftを押しているときは大きく動かす) */
const NUDGE = 16;
const NUDGE_BIG = 64;

/**
 * 幅を変えるつまみ (ペインの右端の縦線)。
 *
 * マウスで引っぱるだけでなく、フォーカスして ← → でも動かせるようにする
 * (読み上げでは「区切り」として、いまの幅も伝わる)
 */
export function PaneSplitter({
  width,
  onStartResize,
  onNudge,
  label,
}: {
  width: number;
  onStartResize: (e: React.MouseEvent) => void;
  /** 幅を足し引きする (無ければキーボードでは動かせない) */
  onNudge?: (delta: number) => void;
  /** 何の幅か (読み上げ用) */
  label: string;
}) {
  return (
    <div
      className="pane-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={onNudge ? 0 : undefined}
      onMouseDown={onStartResize}
      onKeyDown={
        onNudge
          ? (e) => {
              const step = e.shiftKey ? NUDGE_BIG : NUDGE;
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                onNudge(-step);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                onNudge(step);
              }
            }
          : undefined
      }
    />
  );
}

export function SidePane({
  /** 幅 (px)。つまみのドラッグで変わる */
  width,
  /** つまみを押したときに呼ぶ (useResizableWidth が返すもの) */
  onStartResize,
  /** 矢印キーで幅を変える (useResizableWidth の3つ目) */
  onNudge,
  /** 追加のclass (Valkeyのキー一覧など) */
  className,
  /** ペイン自身でキー操作を受けるか (⌘Aの全選択に使う) */
  focusable,
  onKeyDown,
  children,
}: {
  width: number;
  onStartResize: (e: React.MouseEvent) => void;
  onNudge?: (delta: number) => void;
  className?: string;
  focusable?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  children: ReactNode;
}) {
  return (
    <>
      <aside
        className={"table-pane" + (className ? ` ${className}` : "")}
        style={{ width }}
        // ページ内検索の対象外 (このペインには専用の絞り込みがある)
        data-find-skip
        tabIndex={focusable ? 0 : undefined}
        onKeyDown={onKeyDown}
      >
        {children}
      </aside>
      {/* 右端のつまみ (ドラッグか、フォーカスして ← → で幅を変える) */}
      <PaneSplitter
        width={width}
        onStartResize={onStartResize}
        onNudge={onNudge}
        label="一覧の幅"
      />
    </>
  );
}

/** 左ペインの見出し (名前 + 件数 + 右側のボタン) */
export function PaneHead({
  title,
  count,
  children,
}: {
  title: string;
  /** 件数の表示 (出さないときは省略) */
  count?: ReactNode;
  /** 見出しの右に並べるボタン */
  children?: ReactNode;
}) {
  return (
    <div className="table-pane-head">
      <span className="pane-head-title">{title}</span>
      {count !== undefined && count !== null && (
        <span className="panel-count">{count}</span>
      )}
      {children}
    </div>
  );
}
