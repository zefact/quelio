/**
 * CSVエディタのタブを右クリックしたときのメニュー。
 *
 * まとめて閉じると保存していない編集が消えるので、
 * その中に未保存のタブが混ざるときだけ確認を挟む
 */
import { useState } from "react";
import type { CsvInfo } from "../../types";
import { useDismiss } from "../../hooks/useDismiss";
import { usePopupPosition } from "../../hooks/usePopupPosition";
import { ConfirmDialog } from "../ConfirmDialog";
import { CLOSE_LABEL, CloseKind, closeTargets, unsaved } from "./csvTabClose";

interface Props {
  /** 右クリックしたタブ */
  tab: CsvInfo;
  /** 開いている全タブ (閉じる相手を数えるのに使う) */
  tabs: CsvInfo[];
  x: number;
  y: number;
  /** まとめて閉じる (確認が要るものは済ませてから呼ぶ) */
  onCloseMany: (targets: CsvInfo[]) => void;
  onDismiss: () => void;
}

/** メニューが横に広がらないよう、名前は短く切る */
function short(name: string): string {
  return name.length > 16 ? `${name.slice(0, 16)}…` : name;
}

export function CsvTabMenu({ tab, tabs, x, y, onCloseMany, onDismiss }: Props) {
  /** 確認してから閉じる相手 */
  const [confirm, setConfirm] = useState<CloseKind | null>(null);
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(x, y);
  // 確認を出している間はメニューを閉じない (背景クリックは確認側が受ける)
  useDismiss(true, onDismiss, {
    ref: menuRef,
    escape: true,
    resize: true,
    skip: confirm !== null,
  });

  const others = closeTargets(tabs, tab, "others");
  const right = closeTargets(tabs, tab, "right");

  /** 未保存が混ざるときだけ確認する */
  const ask = (kind: CloseKind) => {
    if (unsaved(closeTargets(tabs, tab, kind)).length === 0) {
      onCloseMany(closeTargets(tabs, tab, kind));
      onDismiss();
      return;
    }
    setConfirm(kind);
  };

  if (confirm) {
    const targets = closeTargets(tabs, tab, confirm);
    const lost = unsaved(targets);
    return (
      <ConfirmDialog
        title="保存していない変更があります"
        target={lost.map((t) => short(t.name)).join("、")}
        confirmLabel="保存せずに閉じる"
        onConfirm={() => {
          onCloseMany(targets);
          onDismiss();
        }}
        onCancel={onDismiss}
      >
        {lost.length > 1
          ? "これらのファイルへの変更は失われます。"
          : "このファイルへの変更は失われます。"}
      </ConfirmDialog>
    );
  }

  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={menuStyle}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className="context-item" onClick={() => ask("self")}>
        {CLOSE_LABEL.self}
      </button>
      <button
        className="context-item"
        disabled={right.length === 0}
        title={right.length === 0 ? "右側にタブがありません" : undefined}
        onClick={() => ask("right")}
      >
        {CLOSE_LABEL.right} ({right.length})
      </button>
      <button
        className="context-item"
        disabled={others.length === 0}
        title={others.length === 0 ? "他にタブがありません" : undefined}
        onClick={() => ask("others")}
      >
        {CLOSE_LABEL.others} ({others.length})
      </button>

      <div className="context-sep" aria-hidden />

      <button className="context-item danger" onClick={() => ask("all")}>
        {CLOSE_LABEL.all} ({tabs.length})
      </button>
    </div>
  );
}
