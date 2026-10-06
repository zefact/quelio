/**
 * 固定長の桁設定ダイアログの、下のボタンの並び。
 *
 * ダイアログの開き方で、できることが3通りある:
 * - "apply":    ファイルから開いたタブで開いた。お気に入りに保存も、読み直しもできる
 * - "register": 読み直す相手が無い (ファイルを開いていない)。お気に入りに保存するだけ
 * - "edit":     一覧の ✎ から開いた。そのお気に入りを直すだけ
 */

export type CsvFixedMode = "apply" | "register" | "edit";

interface Props {
  mode: CsvFixedMode;
  /** お気に入り名が入っているか */
  named: boolean;
  /** 桁が正しく決まっているか */
  ready: boolean;
  /** 入れた名前のお気に入りが既にあるか (あれば保存は上書きになる) */
  exists: boolean;
  /** 保存している最中か ("edit" のとき) */
  busy: boolean;
  /** お気に入りに保存する ("edit" のときは、そのお気に入りを差し替える) */
  onSave: () => void;
  /** この桁設定で読み直す ("apply" のときだけ使う) */
  onApply: () => void;
  onClose: () => void;
}

export function CsvFixedFooter({
  mode,
  named,
  ready,
  exists,
  busy,
  onSave,
  onApply,
  onClose,
}: Props) {
  const saveLabel = exists ? "お気に入りを上書き" : "お気に入りに保存";
  const saveTip = named ? undefined : "お気に入り名を入力すると保存できます";

  if (mode === "edit") {
    return (
      <div className="save-sql-actions csv-fixed-actions">
        <span className="toolbar-spacer" />
        <button className="btn-secondary" disabled={busy} onClick={onClose}>
          キャンセル
        </button>
        <button
          className="btn-primary"
          disabled={!named || !ready || busy}
          title={named ? undefined : "お気に入り名を入力してください"}
          onClick={onSave}
        >
          保存
        </button>
      </div>
    );
  }

  if (mode === "register") {
    return (
      <div className="save-sql-actions csv-fixed-actions">
        <span className="toolbar-spacer" />
        <button className="btn-secondary" onClick={onClose}>
          閉じる
        </button>
        <button
          className="btn-primary"
          disabled={!named || !ready}
          title={saveTip}
          onClick={onSave}
        >
          {saveLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="save-sql-actions csv-fixed-actions">
      <button
        className="btn-secondary"
        disabled={!named || !ready}
        title={saveTip}
        onClick={onSave}
      >
        {saveLabel}
      </button>
      <span className="toolbar-spacer" />
      <button className="btn-secondary" onClick={onClose}>
        キャンセル
      </button>
      <button className="btn-primary" disabled={!ready} onClick={onApply}>
        この桁設定で読み直す
      </button>
    </div>
  );
}
