/**
 * ER図のバックアップ (書き出す図を選ぶ)。
 *
 * 保存済みの図にチェックボックスを付け、印を付けたものだけを書き出す。
 * 開いたときは全部に印が付いている (全部書き出すなら、そのまま押すだけ)。
 * ファイルの形は設定画面のバックアップと同じなので、どちらの復元でも読める
 */
import { useState } from "react";
import { pickExportPath } from "../exportDir";
import { exportErDiagramSubset } from "../api";
import { erBackupFileName, toggleName } from "../er/erTransfer";
import { ErIcon } from "./ErIcon";
import { ModalFrame } from "./ModalFrame";
import { RevealButton } from "./RevealButton";

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

interface Props {
  /** 保存済みの図の名前 */
  names: string[];
  /** 開いている図 (目印を付ける) */
  current: string | null;
  onClose: () => void;
}

export function ErBackupDialog({ names, current, onClose }: Props) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(names));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 書き出した数 (書き出したあとは結果だけを出す) */
  const [done, setDone] = useState<number | null>(null);
  /** 書き出したファイル (「フォルダを開く」に使う) */
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const picked = names.filter((n) => sel.has(n));

  const run = async () => {
    if (picked.length === 0 || busy) return;
    const path = await pickExportPath({
      fileName: erBackupFileName(new Date()),
      filters: JSON_FILTER,
      title: "ER図をバックアップ",
    });
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await exportErDiagramSubset(path, picked));
      setSavedPath(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="ER図をバックアップ"
      onClose={onClose}
      closable={!busy}
      className="saved-transfer-modal"
      footer={
        done !== null ? (
          <button className="btn-primary" onClick={onClose}>
            閉じる
          </button>
        ) : (
          <>
            <button className="btn-secondary" onClick={onClose} disabled={busy}>
              キャンセル
            </button>
            <button
              className="btn-primary"
              disabled={picked.length === 0 || busy}
              onClick={() => void run()}
            >
              書き出す…
            </button>
          </>
        )
      }
    >
      {done !== null ? (
        <div className="saved-transfer-body">
          <div className="result-banner ok">
            <span className="dot" aria-hidden />
            <span className="result-detail">ER図を{done}件書き出しました。</span>
            {savedPath && <RevealButton path={savedPath} />}
          </div>
        </div>
      ) : (
        <div className="saved-transfer-body">
          <div className="pick-head">
            <span className="pick-count">
              {names.length}件中 {picked.length}件を書き出します
            </span>
            <span className="toolbar-spacer" />
            <button
              type="button"
              className="lib-action"
              onClick={() => setSel(new Set(names))}
            >
              すべて選ぶ
            </button>
            <button
              type="button"
              className="lib-action"
              onClick={() => setSel(new Set())}
            >
              すべて外す
            </button>
          </div>
          <div className="pick-list">
            {names.map((n) => (
              <label key={n} className="pick-row">
                <input
                  type="checkbox"
                  className="pick-check"
                  checked={sel.has(n)}
                  onChange={() => setSel((s) => toggleName(s, n))}
                />
                <span className="er-pick-icon">
                  <ErIcon />
                </span>
                <span className="pick-name">{n}</span>
                {n === current && <span className="er-pick-meta">開いている図</span>}
              </label>
            ))}
          </div>
          <span className="save-sql-note">
            ページ・配置・注釈・線の見た目も含めて書き出します。書き出したファイルは「復元」で今ある図に追加できます
          </span>
          {error && (
            <div className="result-banner ng">
              <span className="dot" aria-hidden />
              <strong>エラー</strong>
              <span className="result-detail">{error}</span>
            </div>
          )}
        </div>
      )}
    </ModalFrame>
  );
}
