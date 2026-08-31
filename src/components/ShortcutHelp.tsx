import { useModal } from "../hooks/useModal";
import { CTRL, MOD, SHIFT } from "../keyLabel";

interface Props {
  onClose: () => void;
}

/** 見出しと、そのグループのショートカット */
const GROUPS: [string, [string, string][]][] = [
  [
    "タブ・ウィンドウ",
    [
      [`${MOD}T`, "新しいタブ"],
      [`${MOD}W`, "タブを閉じる"],
      [`${MOD}1〜9`, "そのタブへ切り替え"],
      [`${CTRL}Tab`, "次のタブ (⇧で前のタブ)"],
      [`${MOD}K`, "接続先・アクションを探して実行"],
      [`${MOD}/`, "このショートカット一覧"],
    ],
  ],
  [
    "SQLエディタ",
    [
      [`${MOD}Enter`, "実行 (選択部分 / カーソルのある文)"],
      [`${MOD}${SHIFT}Enter`, "全体を実行 (書いてあるSQLすべて)"],
      [`${MOD}S`, "書いているSQLをお気に入りへ保存"],
      [`${MOD}${SHIFT}F`, "SQLを整形 (カンマ先頭)"],
      [`${MOD}F`, "ページ内検索 (F3 / ⇧F3 で次・前へ)"],
    ],
  ],
  [
    "結果グリッド",
    [
      [`${MOD}A`, "表示中の行をすべて選択"],
      [`${MOD}C`, "選択した行 (未選択なら全行) をコピー"],
      ["ダブルクリック", "セルの編集 (データタブ・定義タブ)"],
      ["右クリック", "コピーの形式や、行・カラムの操作"],
      ["Enter / Esc", "編集の反映 / 取り消し"],
    ],
  ],
];

/** ショートカットの一覧 (⌘/) */
export function ShortcutHelp({ onClose }: Props) {
  const boxRef = useModal(onClose);
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal shortcut-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">キーボードショートカット</span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="shortcut-body">
          {GROUPS.map(([title, items]) => (
            <section className="shortcut-group" key={title}>
              <h3 className="shortcut-title">{title}</h3>
              <dl className="shortcut-list">
                {items.map(([keys, desc]) => (
                  <div className="shortcut-row" key={keys + desc}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <div className="modal-actions column-modal-actions">
          <span className="toolbar-spacer" />
          <button className="btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
