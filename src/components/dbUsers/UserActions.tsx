/**
 * 選んでいるユーザーへの操作 (パスワード・名前・停止・削除)。
 *
 * ここでは「何をするか」を決めるだけで、実行はしない。
 * 決まった内容は呼び出し側へ渡し、SQLを見せる確認を通してから流す
 */
import { useState } from "react";
import { useModal } from "../../hooks/useModal";
import type { DbUser, DbUserChange } from "../../types";
import { blockedReason, userRef } from "./dbUserView";
import { imeBusy } from "../../ime";

interface Props {
  user: DbUser;
  /** PostgreSQL か */
  pg: boolean;
  /** 今つないでいるデータベース (削除の断り書きに使う) */
  database: string;
  /** 確認へ進む */
  onAsk: (ask: AskedChange) => void;
}

/** 確認の画面に渡すひとまとまり */
export interface AskedChange {
  title: string;
  change: DbUserChange;
  note?: string;
  /** 打ち込ませる名前 (削除のとき) */
  typeName?: string;
  confirmLabel?: string;
  /**
   * そのSQLを流すデータベース (省略すると今つないでいるもの)。
   *
   * PostgreSQLは、スキーマやテーブルへの権限を
   * そのデータベースへ繋いだ状態でしか付けられない
   */
  database?: string;
  /** 実行できたときに出す短い知らせ */
  done: string;
}

/** 今開いている入力欄 */
type Open = "password" | "rename" | null;

export function UserActions({ user, pg, database, onAsk }: Props) {
  const [open, setOpen] = useState<Open>(null);
  /** PostgreSQLの削除で、先に片付けるか */
  const [cleanup, setCleanup] = useState(true);
  const blocked = blockedReason(user);
  const locked = user.badges.includes("停止中") || (pg && !user.canLogin);
  const word = pg ? "ロール" : "ユーザー";
  const who = userRef(user);

  if (blocked) {
    return <p className="dbusers-blocked">{blocked}</p>;
  }

  return (
    <div className="dbusers-actions">
      <button className="btn-secondary" onClick={() => setOpen("password")}>
        パスワードを変える
      </button>
      <button className="btn-secondary" onClick={() => setOpen("rename")}>
        名前を変える
      </button>
      <button
        className="btn-secondary"
        onClick={() =>
          onAsk({
            title: locked ? `${word}を戻します` : `${word}を止めます`,
            change: { kind: "lock", user: who, locked: !locked },
            note: locked
              ? "また接続できるようになります。権限は変わりません"
              : "接続できなくなります。権限はそのまま残るので、あとから戻せます",
            confirmLabel: locked ? "戻す" : "止める",
            done: locked
              ? `${user.name} は入れるように戻しました`
              : `${user.name} は入れないようにしました`,
          })
        }
      >
        {locked ? "入れるように戻す" : "入れないようにする"}
      </button>
      <button
        className="btn-secondary danger"
        onClick={() =>
          onAsk({
            title: `${word}を削除します`,
            change: { kind: "drop", user: who, cleanup: pg && cleanup },
            note: pg
              ? `このユーザーは接続できなくなり、与えていた権限も一緒に消えます。データそのものは消えません。\nPostgreSQLは権限や持ち物が1つでも残っていると削除できないため、先に「${database}」のぶんを片付けます (持ち物は今つないでいるユーザーへ引き継ぎます)。ほかのデータベースにも残っている場合は、そちらへ接続してからもう一度削除してください`
              : "このユーザーは接続できなくなり、与えていた権限も一緒に消えます。データそのものは消えません",
            typeName: user.name,
            confirmLabel: "削除する",
            done: `${user.name} を削除しました`,
          })
        }
      >
        削除
      </button>

      {open === "password" && (
        <TextPrompt
          title="パスワードを変えます"
          target={user.key}
          label="新しいパスワード"
          secret
          note="入力した値はSQLの記録には残しません"
          onDecide={(v) => {
            setOpen(null);
            onAsk({
              title: "パスワードを変えます",
              change: { kind: "password", user: who, password: v },
              confirmLabel: "変える",
              done: `${user.name} のパスワードを変えました`,
            });
          }}
          onCancel={() => setOpen(null)}
        />
      )}

      {open === "rename" && (
        <TextPrompt
          title="名前を変えます"
          target={user.key}
          label="新しい名前"
          initial={user.name}
          note={pg ? undefined : "接続元はそのまま引き継ぎます"}
          onDecide={(v) => {
            setOpen(null);
            onAsk({
              title: "名前を変えます",
              change: { kind: "rename", user: who, name: v },
              confirmLabel: "変える",
              done: `${user.name} の名前を「${v}」に変えました`,
            });
          }}
          onCancel={() => setOpen(null)}
        />
      )}

      {pg && (
        <label className="dbusers-check dbusers-cleanup">
          <input
            type="checkbox"
            checked={cleanup}
            onChange={(e) => setCleanup(e.target.checked)}
          />
          削除の前に権限と持ち物を片付ける
        </label>
      )}
    </div>
  );
}

/** 1つだけ入力させる小さな画面 (実行はしない) */
function TextPrompt({
  title,
  target,
  label,
  initial = "",
  secret = false,
  note,
  onDecide,
  onCancel,
}: {
  title: string;
  target: string;
  label: string;
  initial?: string;
  secret?: boolean;
  note?: string;
  onDecide: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const boxRef = useModal(onCancel);

  const go = () => value && onDecide(value);

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div
        className="modal ddl-confirm"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            {title}
            <span className="column-modal-target mono">{target}</span>
          </span>
          <button className="modal-close" onClick={onCancel} title="閉じる (Esc)">
            ×
          </button>
        </div>
        <label className="dbusers-type">
          <span className="field-label">{label}</span>
          <input
            className="text-field"
            type={secret ? "password" : "text"}
            autoFocus
            value={value}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !imeBusy(e)) go();
            }}
          />
          {note && <span className="field-note">{note}</span>}
        </label>
        <div className="form-actions">
          <button className="btn-secondary" onClick={onCancel}>
            やめる
          </button>
          <button className="btn-primary" onClick={go} disabled={!value}>
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}
