import { ColorSwatches } from "./ColorSwatches";

interface Props {
  table: string;
  column: string;
  /** 今の文字色 (未設定は既定の色) */
  color: string | undefined;
  /** 文字色を変える (undefined で既定に戻す) */
  onChangeColor: (color: string | undefined) => void;
  /**
   * 選択中の線に対して、このカラムを「対応カラム」にできるか。
   * できないとき (線を選んでいない・代表カラム自身) は null
   */
  edgeColumn: { has: boolean; onToggle: () => void } | null;
  /** 線の追加モードで選んである接続元 (無ければnull) */
  linkSrc: { table: string; column: string } | null;
  onConnectHere: () => void;
  onStartLink: () => void;
  onCancelLink: () => void;
}

/** カラムを右クリックしたときのメニュー (線の追加・対応カラムの増減) */
export function ColumnMenu({
  table,
  color,
  onChangeColor,
  edgeColumn,
  linkSrc,
  onConnectHere,
  onStartLink,
  onCancelLink,
}: Props) {
  return (
    <>
      {edgeColumn && (
        <>
          <button className="context-item" onClick={edgeColumn.onToggle}>
            {edgeColumn.has
              ? "選択中の線の対応から外す"
              : "選択中の線の対応に追加"}
          </button>
          <div className="context-sep" />
        </>
      )}
      {linkSrc && linkSrc.table !== table && (
        <button className="context-item" onClick={onConnectHere}>
          {`${linkSrc.table}.${linkSrc.column} からここへ線を接続`}
        </button>
      )}
      <button className="context-item" onClick={onStartLink}>
        この列から線を追加
      </button>
      {linkSrc && (
        <button className="context-item" onClick={onCancelLink}>
          線の追加をキャンセル
        </button>
      )}
      <div className="context-sep" />
      <div className="context-caption">この行の文字色</div>
      <ColorSwatches
        value={color}
        onSelect={onChangeColor}
        defaultColor="#9aa1b5"
        defaultTitle="既定 (色を付けない)"
      />
    </>
  );
}
