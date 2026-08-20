import { ReactNode } from "react";

interface Props {
  /** 設定名 */
  title: ReactNode;
  /** 灰色の説明文 */
  desc?: ReactNode;
  /**
   * コントロールを説明文の下に横幅いっぱいで置く。
   * 入力欄とボタンが並ぶなど、右側に収まりきらない場合に使う
   */
  stack?: boolean;
  /** 右側 (stack時は下) に置くコントロール (トグル・セレクト等) */
  children?: ReactNode;
}

/** 設定画面の1行 (左: タイトル+説明 / 右: コントロール) */
export function SettingRow({ title, desc, stack, children }: Props) {
  return (
    <div className={"set-row" + (stack ? " set-row-stack" : "")}>
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {desc && <div className="set-row-desc">{desc}</div>}
      </div>
      {children && <div className="set-row-control">{children}</div>}
    </div>
  );
}
