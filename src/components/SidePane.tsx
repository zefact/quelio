/**
 * 左ペインの枠 (幅の変更つき)。
 *
 * テーブル一覧 (SessionView) とキー一覧 (KvSessionView) は
 * 中身こそ違うが、枠と幅の変え方は同じ。
 * 枠だけをここに置き、中身はそれぞれの画面が渡す
 */
import type { ReactNode } from "react";

export function SidePane({
  /** 幅 (px)。つまみのドラッグで変わる */
  width,
  /** つまみを押したときに呼ぶ (useResizableWidth が返すもの) */
  onStartResize,
  /** 追加のclass (Valkeyのキー一覧など) */
  className,
  /** ペイン自身でキー操作を受けるか (⌘Aの全選択に使う) */
  focusable,
  onKeyDown,
  children,
}: {
  width: number;
  onStartResize: (e: React.MouseEvent) => void;
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
        tabIndex={focusable ? 0 : undefined}
        onKeyDown={onKeyDown}
      >
        {children}
      </aside>
      {/* 右端のつまみ (ドラッグで幅を変える) */}
      <div className="pane-splitter" onMouseDown={onStartResize} />
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
      <span>{title}</span>
      {count !== undefined && count !== null && (
        <span className="panel-count">{count}</span>
      )}
      {children}
    </div>
  );
}
