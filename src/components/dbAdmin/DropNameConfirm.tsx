import { useState } from "react";
import type { AdminKind } from "./DbAdminDialog";
import { imeBusy } from "../../ime";
import { ModalFrame } from "../ModalFrame";
import { ProdNote } from "../ProdBadge";
import { dbAdminText } from "../../prodConfirm";

interface Props {
  /** 「データベース」「スキーマ」 */
  kind: AdminKind;
  /** 消す対象の名前 */
  name: string;
  /** 中身ごと消すかを選ばせるか (PostgreSQLのスキーマ) */
  askCascade?: boolean;
  /** 本番の接続か (見出しにバッジ、本文の先頭に本番の1行を出す) */
  prod?: boolean;
  onCancel: () => void;
  /** 実行する。失敗したら例外を投げること */
  onConfirm: (cascade: boolean) => Promise<void>;
}

/**
 * 名前を打ち込ませてから消す確認。
 *
 * テーブル1つと違って、中身がまるごと消えて戻せないので、
 * 「押し間違い」では実行できないようにする
 */
export function DropNameConfirm({
  kind,
  name,
  askCascade = false,
  prod = false,
  onCancel,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState("");
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matched = typed === name;

  const run = async () => {
    if (!matched || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(cascade);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    // 実行中は Esc・背景クリック・× で閉じない
    <ModalFrame
      title={`${kind}を削除します`}
      target={name}
      prod={prod}
      onClose={onCancel}
      closable={!busy}
      className="ddl-confirm"
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-danger"
            disabled={busy || !matched}
            onClick={run}
          >
            {busy ? (
              <>
                <span className="spinner light" /> 実行中…
              </>
            ) : (
              "削除する"
            )}
          </button>
        </>
      }
    >
      <div className="column-modal-body">
        {prod && (
          <ProdNote>{dbAdminText({ kind: "drop", what: kind, name })}</ProdNote>
        )}
        <div className="column-warn">
          この{kind}の中身 (テーブル・データ) はすべて消え、元に戻せません。
          <br />
          実行するには、下の欄に <strong className="mono">{name}</strong>{" "}
          と入力してください。
        </div>

        <input
          className="text-field mono db-admin-typed"
          value={typed}
          spellCheck={false}
          autoFocus
          disabled={busy}
          placeholder={name}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            // 日本語入力の変換確定のEnterで消さない
            if (imeBusy(e)) return;
            if (e.key === "Enter" && matched) void run();
          }}
        />

        {askCascade && (
          <label className="switch db-admin-cascade">
            <input
              type="checkbox"
              checked={cascade}
              disabled={busy}
              onChange={(e) => setCascade(e.target.checked)}
            />
            <span className="track" aria-hidden />
            <span className="switch-label">
              中に何かあっても消す (CASCADE)
            </span>
          </label>
        )}

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
