/**
 * ユーザーへの変更を、実行するSQLを見せてから確かめる画面。
 *
 * 何が起きるかを言葉で書くより、流すSQLをそのまま見せるほうが確かなので、
 * バックエンドに組み立てさせたものを出す
 * (画面で組み立て直すと、実際に流すものとずれる)。
 *
 * 削除だけは名前を打ち込ませる。押し間違いで消えないように
 */
import { useEffect, useRef, useState } from "react";
import { applyDbUserChange, previewDbUserChange } from "../../api";
import type { DbUserChange } from "../../types";
import { imeBusy } from "../../ime";
import { ModalFrame } from "../ModalFrame";
import { ProdNote } from "../ProdBadge";
import { dbUserChangeText } from "../../prodConfirm";

/** 確認の画面で切り替えられる付け足しの指定 (PostgreSQL の削除前の片付けなど) */
export interface ChangeToggle {
  label: string;
  /** 開いたときの値 */
  initial: boolean;
  /** 切り替えたときに流す変更 */
  apply: (on: boolean) => DbUserChange;
}

interface Props {
  sessionId: string;
  database: string;
  /** 見出し (「パスワードを変更します」など) */
  title: string;
  /** 見出しの右に出す相手の名前 */
  target: string;
  change: DbUserChange;
  /** 本文に足す注意書き */
  note?: string;
  /** 打ち込ませる名前 (指定すると、合うまで実行できない) */
  typeName?: string;
  /** 確認の中で切り替えられる指定 (切り替えると流すSQLを組み立て直す) */
  toggle?: ChangeToggle;
  confirmLabel?: string;
  /** 本番の接続か (見出しにバッジ、本文の先頭に1行を出し、フォーカスを「キャンセル」に置く) */
  prod?: boolean;
  /** 実行できたときに呼ぶ (一覧の取り直しなど) */
  onDone: () => void;
  onCancel: () => void;
}

export function ChangeConfirm({
  sessionId,
  database,
  title,
  target,
  change,
  note,
  typeName,
  toggle,
  confirmLabel = "実行する",
  prod = false,
  onDone,
  onCancel,
}: Props) {
  const [sql, setSql] = useState<string[] | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggleOn, setToggleOn] = useState(toggle?.initial ?? false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** 実際に流す変更 (切り替えの指定があれば、それを当てたもの) */
  const current = toggle ? toggle.apply(toggleOn) : change;

  // 本番では、名前を打ち込む欄が無ければ「キャンセル」にフォーカスを置く
  useEffect(() => {
    if (prod && !typeName) cancelRef.current?.focus();
    // 開いた直後だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 開いたとき (と指定を切り替えたとき) に、流すことになるSQLを組み立ててもらう
  useEffect(() => {
    let alive = true;
    setSql(null);
    previewDbUserChange(sessionId, current)
      .then((v) => {
        if (!alive) return;
        setSql(v);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        // 組み立てられなかったことを示す (待ち続けているように見せない)
        setSql([]);
      });
    return () => {
      alive = false;
    };
    // change は開いている間は変わらない。変わるのは切り替えの指定だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, toggleOn]);

  const matched = !typeName || typed === typeName;
  /** 組み立てられなかったら実行させない */
  const ready = matched && !busy && !!sql?.length;

  const run = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await applyDbUserChange(sessionId, database, current);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const danger = change.kind === "drop";

  return (
    // 実行中は Esc・背景クリック・× で閉じない
    <ModalFrame
      title={title}
      target={target}
      prod={prod}
      onClose={onCancel}
      closable={!busy}
      className="ddl-confirm"
      footer={
        <>
          <button
            className="btn-secondary"
            onClick={onCancel}
            disabled={busy}
            ref={cancelRef}
          >
            キャンセル
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={() => void run()}
            disabled={!ready}
          >
            {busy ? (
              <>
                <span className="spinner light" /> 実行中…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </>
      }
    >
      {prod && <ProdNote>{dbUserChangeText(target, title)}</ProdNote>}
      {note && <p className="dbusers-note">{note}</p>}

      {toggle && (
        <label className="dbusers-check dbusers-cleanup">
          <input
            type="checkbox"
            checked={toggleOn}
            disabled={busy}
            onChange={(e) => setToggleOn(e.target.checked)}
          />
          {toggle.label}
        </label>
      )}

      <div className="dbusers-sql">
        <span className="field-label">実行するSQL</span>
        {sql === null ? (
          <div className="routine-empty">
            <span className="spinner accent" /> 組み立てています…
          </div>
        ) : sql.length === 0 ? (
          <div className="csv-empty-hint">組み立てられませんでした</div>
        ) : (
          <pre className="mono">{sql.join(";\n")}</pre>
        )}
      </div>

      {typeName && (
        <label className="dbusers-type">
          {/* 文言はデータベースの削除 (DropNameConfirm) とそろえる */}
          <span className="field-label">
            実行するには、下の欄に <strong className="mono">{typeName}</strong>{" "}
            と入力してください。
          </span>
          <input
            className="text-field mono"
            autoFocus
            value={typed}
            spellCheck={false}
            disabled={busy}
            placeholder={typeName}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // 日本語入力の変換確定のEnterで実行しない
              if (e.key === "Enter" && !imeBusy(e)) void run();
            }}
          />
        </label>
      )}

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}
    </ModalFrame>
  );
}
