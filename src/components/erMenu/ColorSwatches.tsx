import { FRAME_COLORS } from "../../er/style";

interface Props {
  /** 今選んでいる色 (未指定は既定色) */
  value: string | undefined;
  onSelect: (color: string | undefined) => void;
  /** 先頭の「既定」の色見本と説明 */
  defaultColor: string;
  defaultTitle: string;
  /** 先頭を「透明」にする (背景色の指定で使う) */
  transparent?: boolean;
}

/** 色見本の並び (線・枠線・文字色・背景色で使い回す) */
export function ColorSwatches({
  value,
  onSelect,
  defaultColor,
  defaultTitle,
  transparent,
}: Props) {
  if (transparent) {
    return (
      <div className="er-frame-colors">
        <button
          className={"er-frame-color transparent" + (!value ? " checked" : "")}
          title="透明"
          onClick={() => onSelect(undefined)}
        />
        {FRAME_COLORS.slice(1).map((color) => (
          <button
            key={color}
            className={"er-frame-color" + (value === color ? " checked" : "")}
            style={{ background: color }}
            title={color}
            onClick={() => onSelect(color)}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="er-frame-colors">
      {FRAME_COLORS.map((color) => {
        const checked = (value ?? "") === color;
        return (
          <button
            key={color || "default"}
            className={"er-frame-color" + (checked ? " checked" : "")}
            style={{ background: color || defaultColor }}
            title={color || defaultTitle}
            onClick={() => onSelect(color || undefined)}
          />
        );
      })}
    </div>
  );
}
