/**
 * SQLシートのタブを右クリックしたときのメニュー。
 *
 * 「その他を閉じる」「すべて閉じる」は書きかけのSQLがまとめて消えるので、
 * 中身のあるシートが巻き込まれるときだけ確認を挟む
 */
import { useState } from "react";
import type { QuerySheet } from "../types";
import { useDismiss } from "../hooks/useDismiss";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { ConfirmDialog } from "./ConfirmDialog";
import { autoTitle } from "./sheetTitle";

interface Props {
  /** 右クリックしたシート */
  sheet: QuerySheet;
  /** 表に出している全シート (閉じる対象を数えるのに使う) */
  sheets: QuerySheet[];
  x: number;
  y: number;
  /** 実行中は結果の行き先が変わるので、閉じる操作は受け付けない */
  running: boolean;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onSaveFile: (id: string) => void;
  onDismiss: () => void;
}

/** 中身のあるシートの数 (空のシートは消えても困らない) */
function filled(sheets: QuerySheet[]): number {
  return sheets.filter((s) => s.sql.trim() !== "").length;
}

/** メニューに出すシート名 (メニューが横に広がらないよう短く切る) */
function label(s: QuerySheet): string {
  const name = s.title || autoTitle(s.sql);
  return name.length > 14 ? `${name.slice(0, 14)}…` : name;
}

export function SheetTabMenu({
  sheet,
  sheets,
  x,
  y,
  running,
  onClose,
  onCloseOthers,
  onCloseAll,
  onSaveFile,
  onDismiss,
}: Props) {
  /** 確認してから行う操作 */
  const [confirm, setConfirm] = useState<"others" | "all" | null>(null);
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(x, y);
  // 確認を出している間はメニューを閉じない (背景クリックは確認側が受ける)
  useDismiss(true, onDismiss, {
    ref: menuRef,
    escape: true,
    resize: true,
    skip: confirm !== null,
  });

  const others = sheets.filter((s) => s.id !== sheet.id);
  const empty = sheet.sql.trim() === "";
  /** 実行中は閉じられない (理由はツールチップで出す) */
  const busy = running ? "実行中は閉じられません" : undefined;

  /** 中身のあるシートを巻き込むときだけ確認する */
  const ask = (kind: "others" | "all", targets: QuerySheet[]) => {
    if (filled(targets) === 0) {
      if (kind === "others") onCloseOthers(sheet.id);
      else onCloseAll();
      onDismiss();
      return;
    }
    setConfirm(kind);
  };

  if (confirm) {
    const targets = confirm === "others" ? others : sheets;
    return (
      <ConfirmDialog
        title={confirm === "others" ? "他のシートを閉じます" : "すべて閉じます"}
        target={`${filled(targets)}枚`}
        confirmLabel="閉じる"
        onConfirm={() => {
          if (confirm === "others") onCloseOthers(sheet.id);
          else onCloseAll();
          onDismiss();
        }}
        onCancel={onDismiss}
      >
        書きかけのSQLは元に戻せません。
        {confirm === "all" && " 空のシートが1枚だけ残ります。"}
      </ConfirmDialog>
    );
  }

  return (
    <div
      className="context-menu sheet-menu"
      ref={menuRef}
      style={menuStyle}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className="context-item"
        disabled={running || sheets.length <= 1}
        title={busy ?? (sheets.length <= 1 ? "最後の1枚は閉じられません" : undefined)}
        onClick={() => {
          onClose(sheet.id);
          onDismiss();
        }}
      >
        閉じる
      </button>
      <button
        className="context-item"
        disabled={running || others.length === 0}
        title={busy}
        onClick={() => ask("others", others)}
      >
        その他を閉じる ({others.length})
      </button>
      <button
        className="context-item danger"
        disabled={running}
        title={busy}
        onClick={() => ask("all", sheets)}
      >
        すべて閉じる
      </button>

      <div className="context-sep" aria-hidden />

      <button
        className="context-item"
        disabled={empty}
        title={empty ? "書いてあるSQLがありません" : undefined}
        onClick={() => {
          onSaveFile(sheet.id);
          onDismiss();
        }}
      >
        「{label(sheet)}」をファイルに保存...
      </button>
    </div>
  );
}
