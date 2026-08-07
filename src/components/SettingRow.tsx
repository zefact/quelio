import { ReactNode } from "react";

interface Props {
  /** 設定名 */
  title: ReactNode;
  /** 灰色の説明文 */
  desc?: ReactNode;
  /** 右側に置くコントロール (トグル・セレクト等) */
  children?: ReactNode;
}

/** 設定画面の1行 (左: タイトル+説明 / 右: コントロール) */
export function SettingRow({ title, desc, children }: Props) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {desc && <div className="set-row-desc">{desc}</div>}
      </div>
      {children && <div className="set-row-control">{children}</div>}
    </div>
  );
}
