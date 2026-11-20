import type { ReactNode } from "react";

interface Props {
  /** 実行中か (スピナーを出し、ボタンを押せなくする) */
  busy: boolean;
  /** 失敗の理由 (無ければ null) */
  error: string | null;
  /** エラーを閉じる (編集していないときだけ「閉じる」を出す) */
  onDismissError: () => void;
  /** 編集中か (編集中だけ「変更を破棄」「保存する」を出す) */
  editing: boolean;
  /** 変更があるか (無ければ保存を押せなくする) */
  changed?: boolean;
  /**
   * 編集中に出す案内。
   * 既定は「Enter で保存 / Esc で破棄」。SQLの下見などを足したいときに渡す
   */
  hint?: ReactNode;
  /** 案内の後ろに付け足すもの (変更が無いときの注記など) */
  hintExtra?: ReactNode;
  /** 案内とボタンのあいだに置く操作 (NULL を入れるボタンなど) */
  tools?: ReactNode;
  onCancel?: () => void;
  onSave?: () => void;
  /** 保存ボタンの文字 (既定は「保存する」) */
  saveLabel?: string;
  /** 破棄ボタンの文字 (既定は「変更を破棄」) */
  cancelLabel?: string;
  /** 保存を押せない理由 (ツールチップに出す) */
  saveDisabledReason?: string;
}

/** 既定の案内 (キー操作) */
export function EditKeysHint() {
  return (
    <>
      <kbd>Enter</kbd> で保存 / <kbd>Esc</kbd> で破棄
    </>
  );
}

/**
 * その場で編集する表の上に出す帯 (データ・カラム・インデックス・外部キー・Valkey の値)。
 *
 * どの表でも同じ並び・同じ言葉にする:
 * 左に「実行中…」かエラーか案内、右に [変更を破棄] [保存する]
 */
export function EditBar({
  busy,
  error,
  onDismissError,
  editing,
  changed = true,
  hint,
  hintExtra,
  tools,
  onCancel,
  onSave,
  saveLabel = "保存する",
  cancelLabel = "変更を破棄",
  saveDisabledReason,
}: Props) {
  if (!editing && !busy && !error) return null;
  return (
    <div className="ddl-bar">
      {busy ? (
        <>
          <span className="spinner accent" />
          <span className="ddl-bar-text">実行中…</span>
        </>
      ) : error ? (
        <>
          <span className="ddl-bar-icon ng" aria-hidden>
            !
          </span>
          <span className="ddl-bar-text ng">{error}</span>
        </>
      ) : (
        <span className="ddl-bar-text">
          {hint ?? <EditKeysHint />}
          {hintExtra}
        </span>
      )}
      <span className="toolbar-spacer" />
      {editing && tools}
      {editing ? (
        <>
          {onCancel && (
            <button className="ddl-bar-btn" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </button>
          )}
          {onSave && (
            <button
              className="ddl-bar-btn primary has-tooltip"
              onClick={onSave}
              disabled={busy || !changed}
              data-tooltip={!changed ? (saveDisabledReason ?? "変更はまだありません") : undefined}
            >
              {saveLabel}
            </button>
          )}
        </>
      ) : (
        error && (
          <button className="ddl-bar-btn" onClick={onDismissError}>
            閉じる
          </button>
        )
      )}
    </div>
  );
}
