import { useModal } from "../hooks/useModal";
import { QUICK_SHORTCUTS } from "../shortcuts";

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
