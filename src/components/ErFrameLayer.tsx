/**
 * ER図に置く注釈 (枠と見出しテキスト) の描画。
 *
 * 図の読み込みや選択とは関係なく、渡されたものを描いて
 * 操作を通知するだけ。ErWindow から切り出して、
 * 図そのもの (テーブルと線) の処理と混ざらないようにしている
 */
import { charUnits } from "../er/model";
import { FILL_ALPHA, hexAlpha } from "../er/style";
import type { ErFrame } from "../types";

/** 注釈に対する操作 (どれも「どの注釈か」を id で受け取る) */
export interface FrameHandlers {
  /** 編集中の注釈 (無ければ null) */
  editingId: string | null;
  /** 編集中の文字 */
  editText: string;
  onEditText: (text: string) => void;
  /** 編集を確定する */
  onCommitEdit: () => void;
  /** 編集をやめる */
  onCancelEdit: () => void;
  onStartDrag: (e: React.MouseEvent, id: string) => void;
  onStartResize: (e: React.MouseEvent, id: string) => void;
  onStartEditing: (frame: ErFrame) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
}

/** 編集入力の共通キー操作 (Enterで確定 / Escで取消) */
function editKeys(h: FrameHandlers) {
  return (e: React.KeyboardEvent) => {
    // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") h.onCommitEdit();
    else if (e.key === "Escape") h.onCancelEdit();
  };
}

/** 注釈枠 (box) 1個 */
export function ErBox({ frame: f, h }: { frame: ErFrame; h: FrameHandlers }) {
  return (
    <div
      className={"er-frame " + f.style + (f.rounded === false ? " square" : "")}
      style={{
        left: f.x,
        top: f.y,
        width: f.w,
        height: f.h,
        borderColor:
          f.style !== "none" && f.color ? hexAlpha(f.color, 0.75) : undefined,
        background: f.fill ? hexAlpha(f.fill, FILL_ALPHA) : undefined,
      }}
    >
      <div
        className="er-frame-label"
        title="ドラッグで移動 / ダブルクリックで編集 / 右クリックでメニュー"
        onMouseDown={(e) => {
          if (f.id === h.editingId) return;
          h.onStartDrag(e, f.id);
        }}
        onDoubleClick={() => h.onStartEditing(f)}
        onContextMenu={(e) => h.onContextMenu(e, f.id)}
      >
        {f.id === h.editingId ? (
          <input
            className="er-inline-input"
            value={h.editText}
            autoFocus
            onChange={(e) => h.onEditText(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={editKeys(h)}
            onBlur={h.onCommitEdit}
          />
        ) : (
          f.label
        )}
      </div>
      <div
        className="er-frame-resize"
        title="ドラッグでサイズ変更"
        onMouseDown={(e) => h.onStartResize(e, f.id)}
      />
    </div>
  );
}

/** テキスト見出し1個 (編集中はその場で入力欄になる) */
export function ErTextLabel({
  frame: f,
  h,
}: {
  frame: ErFrame;
  h: FrameHandlers;
}) {
  const size = f.fontSize ?? 18;
  if (f.id === h.editingId) {
    return (
      <input
        className="er-text er-text-edit"
        style={{
          left: f.x,
          top: f.y,
          fontSize: size,
          color: f.textColor || undefined,
          // 入力中の文字数に合わせて広げる (全角は2文字ぶんで数える)
          width: Math.max(80, charUnits(h.editText) * size * 0.55 + 40),
        }}
        value={h.editText}
        autoFocus
        onChange={(e) => h.onEditText(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={editKeys(h)}
        onBlur={h.onCommitEdit}
      />
    );
  }
  return (
    <div
      className="er-text"
      style={{
        left: f.x,
        top: f.y,
        fontSize: size,
        color: f.textColor || undefined,
      }}
      title="ドラッグで移動 / ダブルクリックで編集 / 右クリックでメニュー"
      onMouseDown={(e) => h.onStartDrag(e, f.id)}
      onDoubleClick={() => h.onStartEditing(f)}
      onContextMenu={(e) => h.onContextMenu(e, f.id)}
    >
      {f.label}
    </div>
  );
}

/** 注釈をまとめて描く (種類ごとに呼び分ける) */
export function ErFrameLayer({
  frames,
  h,
}: {
  frames: ErFrame[];
  h: FrameHandlers;
}) {
  return (
    <>
      {frames.map((f) =>
        f.kind === "text" ? (
          <ErTextLabel key={f.id} frame={f} h={h} />
        ) : (
          <ErBox key={f.id} frame={f} h={h} />
        )
      )}
    </>
  );
}
