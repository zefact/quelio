import { useState } from "react";
import { importConnections } from "../../api";
import { ModalFrame } from "../ModalFrame";
import { imeBusy } from "../../ime";
import type { ConnectionsFileInfo, ImportCounts } from "../../types";
import { overwrittenNames, restoreCounts } from "../../restorePreview";

interface Props {
  /** 取り込むファイル */
  path: string;
  info: ConnectionsFileInfo;
  /** 取り込めたら結果を渡して閉じる */
  onDone: (r: ImportCounts) => void;
  onClose: () => void;
}

/**
 * パスワード入りの接続一覧を復元する。
 *
 * バックアップのときに決めたパスワードを入れてもらい、ファイルの中のパスワードも取り込む。
 * パスワードが分からないときは、パスワード抜きで接続先だけを取り込める
 */
export function ConnectionImportDialog({ path, info, onDone, onClose }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (withSecrets: boolean) => {
    if (busy || (withSecrets && !password)) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await importConnections(path, withSecrets ? password : undefined));
    } catch (e) {
      // パスワードが違うときは、何も取り込まずにここへ来る (入れ直してもらう)
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="接続一覧を復元します"
      onClose={onClose}
      closable={!busy}
      className="ddl-confirm"
      // パスワード抜きで取り込む道もあるので、主ボタンから離して左に置く
      footerNote={
        <button
          className="btn-secondary has-tooltip"
          disabled={busy}
          data-tooltip="接続先の設定だけを取り込みます (パスワードはあとで入れ直します)"
          onClick={() => void run(false)}
        >
          パスワードは取り込まない
        </button>
      }
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={busy || !password}
            onClick={() => void run(true)}
          >
            {busy ? "取り込み中…" : "パスワードも取り込む"}
          </button>
        </>
      }
    >

        <div className="column-modal-body backup-secret-body">
          <p className="backup-secret-note">
            {`このファイルには、接続先${info.connections}件と、暗号化したパスワード・SSHのパスフレーズが入っています。` +
              "バックアップのときに決めたパスワードを入れると、それも取り込みます。"}
          </p>
          {/* 取り込んだら何件増えて、どれが上書きされるか (書き込まずに数えたもの) */}
          <p className="backup-secret-note">
            {restoreCounts(info.preview)}
            {info.preview.updated > 0 && (
              <>
                <br />
                上書きされるもの: {overwrittenNames(info.preview.updatedNames)}
              </>
            )}
          </p>
          <label className="backup-secret-field">
            <span className="field-label">バックアップのパスワード</span>
            <input
              className="text-field"
              type="password"
              autoFocus
              value={password}
              disabled={busy}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (imeBusy(e)) return;
                if (e.key === "Enter") void run(true);
              }}
            />
          </label>

          {error && (
            <div className="result-banner ng column-error">
              <span className="dot" aria-hidden />
              <strong>エラー</strong>
              <span className="result-detail">{error}</span>
            </div>
          )}
        </div>
    </ModalFrame>
  );
}
