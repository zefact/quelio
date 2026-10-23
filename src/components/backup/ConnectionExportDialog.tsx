import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { exportConnections } from "../../api";
import { useModal } from "../../hooks/useModal";
import { backupPasswordProblem } from "./backupPassword";

interface Props {
  /** 保存先の初期のファイル名 */
  defaultName: string;
  /** 書き出せたら、知らせる文を渡して閉じる */
  onDone: (message: string) => void;
  onClose: () => void;
}

/**
 * 接続一覧のバックアップ。
 *
 * パスワード・SSHのパスフレーズは、選んだときだけ入れる。
 * 入れるときはここで決めたパスワードで暗号化する (平文では書かない)。
 * アプリの鍵は別のPCで使えないので、復元するときはこのパスワードを入れてもらう
 */
export function ConnectionExportDialog({ defaultName, onDone, onClose }: Props) {
  const [withSecrets, setWithSecrets] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useModal(onClose, !busy);

  const problem = withSecrets ? backupPasswordProblem(password, confirm) : null;

  const run = async () => {
    if (busy || problem) return;
    setError(null);
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "JSON", extensions: ["json"] }],
      title: "接続一覧をバックアップ",
    }).catch(() => null);
    if (!path) return;
    setBusy(true);
    try {
      const r = await exportConnections(path, withSecrets ? password : undefined);
      let message = `接続一覧を${r.count}件バックアップしました`;
      if (withSecrets) {
        message += ` (パスワード入り ${r.secrets}件)`;
        if (r.locked > 0) {
          message += `。${r.locked}件は保存されたパスワードを復号できず、入れていません`;
        }
      }
      onDone(message);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal ddl-confirm"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">接続一覧をバックアップします</span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={busy}
            title="閉じる (Esc)"
          >
            ×
          </button>
        </div>

        <div className="column-modal-body backup-secret-body">
          <label className="switch">
            <input
              type="checkbox"
              checked={withSecrets}
              disabled={busy}
              onChange={(e) => setWithSecrets(e.target.checked)}
            />
            <span className="track" aria-hidden />
            <span className="switch-label">
              パスワードとSSHのパスフレーズも含める
            </span>
          </label>

          {withSecrets ? (
            <>
              <p className="backup-secret-note">
                {"ファイルの中のパスワードは、ここで決めるパスワードで暗号化します。" +
                  "復元するときに同じパスワードを入れてください。"}
                <strong>忘れると、ファイルのパスワードは取り出せません</strong>
                (接続先の設定そのものは取り込めます)。
              </p>
              <label className="backup-secret-field">
                <span className="field-label">バックアップのパスワード (8文字以上)</span>
                <input
                  className="text-field"
                  type="password"
                  autoFocus
                  value={password}
                  disabled={busy}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <label className="backup-secret-field">
                <span className="field-label">もう一度</span>
                <input
                  className="text-field"
                  type="password"
                  value={confirm}
                  disabled={busy}
                  autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
              {(password || confirm) && problem && (
                <p className="backup-secret-problem">{problem}</p>
              )}
            </>
          ) : (
            <p className="backup-secret-note">
              パスワードとSSHのパスフレーズは含めません (復元したあとに入れ直してください)。
            </p>
          )}

          {error && (
            <div className="result-banner ng column-error">
              <span className="dot" aria-hidden />
              <strong>エラー</strong>
              <span className="result-detail">{error}</span>
            </div>
          )}
        </div>

        <div className="modal-actions column-modal-actions">
          <span className="toolbar-spacer" />
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={busy || !!problem}
            onClick={() => void run()}
          >
            {busy ? "書き出し中..." : "保存先を選んで書き出す"}
          </button>
        </div>
      </div>
    </div>
  );
}
