import { QUICK_SHORTCUTS } from "../shortcuts";
import { ModalFrame } from "./ModalFrame";

interface Props {
  onClose: () => void;
}

/**
 * ショートカットの一覧 (⌘/)。
 *
 * ここはDBの画面でよく使うぶんだけを出す。
 * CSVエディタ・ER図まで含めた全部は、ヘルプの「ショートカット」で見られる
 */
export function ShortcutHelp({ onClose }: Props) {
  return (
    <ModalFrame
      title="キーボードショートカット"
      onClose={onClose}
      className="shortcut-modal"
      footerNote="CSVエディタ・ER図のぶんは、ヘルプの「ショートカット」にあります"
      footer={
        <button className="btn-primary" onClick={onClose}>
          閉じる
        </button>
      }
    >
      <div className="shortcut-body">
        {QUICK_SHORTCUTS.map(({ title, items }) => (
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
    </ModalFrame>
  );
}
