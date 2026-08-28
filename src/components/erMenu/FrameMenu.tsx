import { ColorSwatches } from "./ColorSwatches";
import { StyleItems } from "./StyleItems";
import type { ErFrame } from "../../types";

const BOX_STYLES = [
  ["solid", "実線"],
  ["dashed", "破線"],
  ["dotted", "点線"],
  ["none", "枠線なし"],
] as const;

/** 文字サイズの候補 (px) */
const FONT_SIZES = [14, 18, 24, 32, 48];

/** テキスト見出しの既定の文字サイズ */
const DEFAULT_FONT_SIZE = 18;

interface Props {
  frame: ErFrame;
  onPatch: (patch: Partial<ErFrame>) => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** 枠・テキスト見出しを右クリックしたときのメニュー */
export function FrameMenu({ frame: f, onPatch, onEdit, onDelete }: Props) {
  const editBtn = (
    <button className="context-item" onClick={onEdit}>
      テキストを編集...
    </button>
  );

  if (f.kind === "text") {
    return (
      <>
        {editBtn}
        <div className="context-sep" />
        <div className="context-caption">文字サイズ (px)</div>
        <div className="er-size-row" onMouseDown={(e) => e.stopPropagation()}>
          <input
            className="er-size-input"
            type="number"
            min={8}
            max={200}
            defaultValue={f.fontSize ?? DEFAULT_FONT_SIZE}
            autoFocus
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const v = Math.round(Number((e.target as HTMLInputElement).value));
              if (Number.isFinite(v) && v >= 8 && v <= 200) {
                onPatch({ fontSize: v });
              }
            }}
          />
          <span className="er-size-hint">Enterで適用</span>
        </div>
        <div className="er-size-chips">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              className={
                "er-size-chip" +
                ((f.fontSize ?? DEFAULT_FONT_SIZE) === size ? " checked" : "")
              }
              onClick={() => onPatch({ fontSize: size })}
            >
              {size}
            </button>
          ))}
        </div>
        <div className="context-sep" />
        <div className="context-caption">文字色</div>
        <ColorSwatches
          value={f.textColor}
          onSelect={(textColor) => onPatch({ textColor })}
          defaultColor="#8b93a8"
          defaultTitle="グレー (既定)"
        />
        <div className="context-sep" />
        <button className="context-item danger" onClick={onDelete}>
          テキストを削除
        </button>
      </>
    );
  }

  // 枠 (box) のメニュー
  return (
    <>
      {editBtn}
      <div className="context-sep" />
      <div className="context-caption">枠線</div>
      <StyleItems
        options={BOX_STYLES}
        value={f.style}
        onSelect={(style) => onPatch({ style })}
      />
      <ColorSwatches
        value={f.color}
        onSelect={(color) => onPatch({ color })}
        defaultColor="#8b93a8"
        defaultTitle="グレー (既定)"
      />
      <div className="context-sep" />
      <div className="context-caption">背景色</div>
      <ColorSwatches
        transparent
        value={f.fill}
        onSelect={(fill) => onPatch({ fill })}
        defaultColor="#8b93a8"
        defaultTitle="透明"
      />
      <div className="context-sep" />
      <button
        className="context-item"
        onClick={() => onPatch({ rounded: f.rounded === false })}
      >
        {f.rounded === false ? "角丸にする" : "四角にする"}
      </button>
      <button
        className="context-item"
        onClick={() => onPatch({ front: !f.front })}
      >
        {f.front ? "テーブルの背面に表示" : "テーブルの前面に表示"}
      </button>
      <div className="context-sep" />
      <button className="context-item danger" onClick={onDelete}>
        枠を削除
      </button>
    </>
  );
}
