import { ColorSwatches } from "./ColorSwatches";
import { StyleItems } from "./StyleItems";
import type { ErEdgeStyle } from "../../types";

const EDGE_STYLES = [
  ["solid", "実線"],
  ["dashed", "破線"],
  ["dotted", "点線"],
] as const;

interface Props {
  /** 今の見た目 (未設定なら既定) */
  style: ErEdgeStyle | undefined;
  /** 接続位置を手で動かしてあるか (「自動に戻す」を出すかの判断) */
  hasAnchors: boolean;
  onOpenPanel: () => void;
  onChangeStyle: (patch: Partial<ErEdgeStyle>) => void;
  onResetAnchors: () => void;
  onDelete: () => void;
}

/** 線を右クリックしたときのメニュー */
export function EdgeMenu({
  style,
  hasAnchors,
  onOpenPanel,
  onChangeStyle,
  onResetAnchors,
  onDelete,
}: Props) {
  return (
    <>
      <button className="context-item" onClick={onOpenPanel}>
        カラムの対応を編集... (ダブルクリックでも可)
      </button>
      <div className="context-sep" />
      <div className="context-caption">線種</div>
      <StyleItems
        options={EDGE_STYLES}
        value={style?.style ?? "dashed"}
        onSelect={(s) => onChangeStyle({ style: s })}
      />
      <ColorSwatches
        value={style?.color}
        onSelect={(color) => onChangeStyle({ color })}
        defaultColor="#6366f1"
        defaultTitle="既定 (インディゴ)"
      />
      <div className="context-sep" />
      {hasAnchors && (
        <button className="context-item" onClick={onResetAnchors}>
          接続位置を自動に戻す
        </button>
      )}
      <button className="context-item danger" onClick={onDelete}>
        線を削除
      </button>
    </>
  );
}
