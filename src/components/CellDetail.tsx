import { useEffect, useMemo, useState } from "react";
import { useModal } from "../hooks/useModal";
import type { Clip } from "../cellValue";
import { clippedHead } from "../cellValue";
import { writeClipboard } from "../gridCopy";
import { tryFormatValue } from "../kvFormat";
import type { CellValue } from "../types";

interface Props {
  /** 見出しに出すカラム名 */
  column: string;
  /** 画面が持っている値 (長ければ切り詰め済み) */
  value: string;
  /** 切り詰められている場合の長さ (切り詰めていなければ null) */
  clip: Clip | null;
  /**
   * 全文を読み直す (できる画面だけ渡す)。
   * データタブは主キーで行を特定できるので取得できる
   */
  onFetchFull?: () => Promise<CellValue>;
  onClose: () => void;
}

/**
 * セル1つの内容をゆっくり読む・まるごとコピーするための画面。
 * グリッドでは長い値が切り詰められるため、ここで全文を取り直せるようにする
 */
export function CellDetail({ column, value, clip, onFetchFull, onClose }: Props) {
  const [text, setText] = useState(() => clippedHead(value, clip));
  /** 全文を取得済みか (未取得なら先頭だけ) */
  const [full, setFull] = useState(clip === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * 整形して表示するか。
   * ここは1つの値をじっくり読むための画面なので、整形できるなら最初から整形する
   * (Valkeyの一覧は行数が多いので既定は素のまま、と使い分けている)
   */
  const [pretty, setPretty] = useState(true);
  const boxRef = useModal(onClose);

  // 別のセルを開いたときに、前のセルの内容が残らないようにする
  useEffect(() => {
    setText(clippedHead(value, clip));
    setFull(clip === null);
    setError(null);
    setCopied(false);
  }, [value, clip]);

  /*
   * 整形した値 (JSON / PHPシリアライズ)。
   * 途中までしか無い値は解析できないので、全文がそろってから試す
   */
  const formatted = useMemo(
    () => (full ? tryFormatValue(text) : null),
    [full, text]
  );
  /** 実際に画面へ出す文字列 */
  const shownText = pretty && formatted !== null ? formatted : text;

  const fetchFull = async () => {
    if (!onFetchFull) return null;
    setBusy(true);
    setError(null);
    try {
      const got = await onFetchFull();
      if (!got.found) {
        setError("この行が見つかりませんでした (取得し直してください)");
        return null;
      }
      const v = got.value ?? "";
      setText(v);
      setFull(true);
      if (got.value === null) setError("この値はNULLになっています");
      return v;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    // 先頭しか持っていない場合は、まず全文を取ってからコピーする。
    // 整形して見ているときは、見えているとおりの文字列をコピーする
    const body = full ? shownText : ((await fetchFull()) ?? text);
    try {
      await writeClipboard(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("コピーできませんでした");
    }
  };

  /** 表示中の文字数 (絵文字などを1文字として数える。元の値で数える) */
  const shown = [...text].length;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal cell-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            セルの内容
            <span className="column-modal-target mono">{column}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="cell-modal-body">
          <div className="cell-meta">
            <span className="faint">
              {full
                ? `${shown.toLocaleString()}文字`
                : `先頭${shown.toLocaleString()}文字 (全${(clip?.total ?? 0).toLocaleString()}文字)`}
            </span>
            {formatted !== null && (
              <button
                className="btn-secondary"
                onClick={() => setPretty((v) => !v)}
                title="JSON・PHPシリアライズを読みやすく折り返して表示します"
              >
                {pretty ? "元の表示" : "整形"}
              </button>
            )}
            {!full && (
              <button
                className="btn-secondary"
                onClick={fetchFull}
                disabled={busy || !onFetchFull}
                title={
                  onFetchFull
                    ? "この行をもう一度読み、全文を取得します"
                    : "SQLの実行結果では行を特定できないため取得できません"
                }
              >
                {busy ? (
                  <>
                    <span className="spinner" /> 取得中...
                  </>
                ) : (
                  "全文を取得"
                )}
              </button>
            )}
          </div>

          <textarea className="cell-text mono" value={shownText} readOnly />

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
          <button className="btn-secondary" onClick={copy} disabled={busy}>
            {copied
              ? "コピーしました"
              : full || onFetchFull
                ? "コピー"
                : "先頭のみコピー"}
          </button>
          <button className="btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
