import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../gridCopy";
import { ModalFrame } from "./ModalFrame";

/**
 * SQLを見せるダイアログ (CREATE 文・CREATE INDEX 文・ALTER 文) に共通のボタン欄。
 *
 * どの画面でも並びを同じにする: [閉じる] [コピー] [SQLエディタへ送る]。
 * エディタへ送れる画面ではそれを主ボタンにし、送れない画面 (別ウィンドウなど) ではコピーを主にする
 */
export function SqlDialogButtons({
  text,
  onClose,
  onSendToEditor,
  onError,
}: {
  /** コピー・送る中身 (空なら押せない) */
  text: string;
  onClose: () => void;
  /** 渡すと「SQLエディタへ送る」を出す (送ったら閉じる) */
  onSendToEditor?: (sql: string) => void;
  /** コピーに失敗したとき */
  onError?: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    try {
      await writeClipboard(text);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      onError?.("コピーできませんでした");
    }
  };

  return (
    <>
      <button className="btn-secondary" onClick={onClose}>
        閉じる
      </button>
      <button
        className={onSendToEditor ? "btn-secondary" : "btn-primary"}
        onClick={() => void copy()}
        disabled={!text}
      >
        {copied ? "コピーしました" : "コピー"}
      </button>
      {onSendToEditor && (
        <button
          className="btn-primary has-tooltip"
          disabled={!text}
          data-tooltip="SQLエディタに入れます (ここでは実行しません)"
          onClick={() => {
            onSendToEditor(text);
            onClose();
          }}
        >
          SQLエディタへ送る
        </button>
      )}
    </>
  );
}

interface Props {
  /** 見出し (例: ALTER文) */
  title: string;
  /** 見出しの右に出す対象名 */
  target?: string;
  /** 表示するSQL */
  text: string;
  onClose: () => void;
  /** 渡すと「SQLエディタへ送る」を出す */
  onSendToEditor?: (sql: string) => void;
}

/**
 * 組み立てたSQLを読ませてコピーさせるだけの画面。
 * ここからは実行しない (内容を確かめてからSQLエディタで流す前提)
 */
export function SqlTextDialog({
  title,
  target,
  text,
  onClose,
  onSendToEditor,
}: Props) {
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalFrame
      title={title}
      target={target}
      onClose={onClose}
      className="cell-modal"
      footer={
        <SqlDialogButtons
          text={text}
          onClose={onClose}
          onSendToEditor={onSendToEditor}
          onError={setError}
        />
      }
    >
      <div className="cell-modal-body">
        <div className="cell-meta">
          <span className="faint">
            内容を確かめてから実行してください (この画面では実行しません)
          </span>
        </div>
        <textarea className="cell-text mono" value={text} readOnly />
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
