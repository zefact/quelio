/**
 * 選んでいるユーザーへの操作 (パスワード・名前・停止・削除)。
 *
 * ここでは「何をするか」を決めるだけで、実行はしない。
 * 決まった内容は呼び出し側へ渡し、SQLを見せる確認を通してから流す
 */
import { useState } from "react";
import type { DbUser, DbUserChange } from "../../types";
import { ModalFrame } from "../ModalFrame";
import type { ChangeToggle } from "./ChangeConfirm";
import { blockedReason, userRef } from "./dbUserView";
import { imeBusy } from "../../ime";

interface Props {
  user: DbUser;
  /** PostgreSQL か */
  pg: boolean;
  /** 今接続しているデータベース (削除の断り書きに使う) */
  database: string;
  /** 確認へ進む */
  onAsk: (ask: AskedChange) => void;
}

/** 確認の画面に渡すひとまとまり */
export interface AskedChange {
  title: string;
  change: DbUserChange;
  note?: string;
  /** 見出しの右に出す相手 (省略すると選んでいるユーザー) */
  target?: string;
  /** 打ち込ませる名前 (削除のとき) */
  typeName?: string;
  /** 確認の中で切り替えられる指定 (PostgreSQL の削除前の片付け) */
  toggle?: ChangeToggle;
  confirmLabel?: string;
  /**
   * そのSQLを流すデータベース (省略すると今接続しているもの)。
   *
   * PostgreSQLは、スキーマやテーブルへの権限を
   * そのデータベースへ接続した状態でしか付けられない
   */
  database?: string;
  /** 実行できたときに出す短い知らせ */
  done: string;
}

/** 今開いている入力欄 */
type Open = "password" | "rename" | null;

export function UserActions({ user, pg, database, onAsk }: Props) {
  const [open, setOpen] = useState<Open>(null);
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
        パスワードを変更
      </button>
      <button className="btn-secondary" onClick={() => setOpen("rename")}>
        名前を変更
      </button>
      <button
        className="btn-secondary"
        onClick={() =>
          onAsk({
            title: locked ? `${word}の停止を解除します` : `${word}を停止します`,
            change: { kind: "lock", user: who, locked: !locked },
            note: locked
              ? "また接続できるようになります。権限は変わりません"
              : "接続できなくなります。権限はそのまま残るので、あとから停止を解除できます",
            confirmLabel: locked ? "停止を解除する" : "停止する",
            done: locked
              ? `${user.name} の停止を解除しました`
              : `${user.name} を停止しました`,
          })
        }
      >
        {locked ? "停止を解除" : "停止"}
      </button>
      <button
        className="btn-secondary danger"
        onClick={() =>
          onAsk({
            title: `${word}を削除します`,
            change: { kind: "drop", user: who, cleanup: pg },
            note: pg
              ? `このユーザーは接続できなくなり、与えていた権限も一緒に消えます。データそのものは消えません。\nPostgreSQLは権限や持ち物が1つでも残っていると削除できません。下の「片付ける」を選ぶと、先に「${database}」のぶんを片付けます (持ち物は今接続しているユーザーへ引き継ぎます)。ほかのデータベースにも残っている場合は、そちらへ接続してからもう一度削除してください`
              : "このユーザーは接続できなくなり、与えていた権限も一緒に消えます。データそのものは消えません",
            // 片付けるかどうかは、削除の確認の中で選ぶ (流すSQLもそこで変わる)
            toggle: pg
              ? {
                  label: "削除の前に権限と持ち物を片付ける",
                  initial: true,
                  apply: (on) => ({ kind: "drop", user: who, cleanup: on }),
                }
              : undefined,
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
          title="パスワードを変更します"
          target={user.key}
          label="新しいパスワード"
          secret
          note="入力した値はSQLの記録には残しません"
          onDecide={(v) => {
            setOpen(null);
            onAsk({
              title: "パスワードを変更します",
              change: { kind: "password", user: who, password: v },
              confirmLabel: "変更する",
              done: `${user.name} のパスワードを変更しました`,
            });
          }}
          onCancel={() => setOpen(null)}
        />
      )}

      {open === "rename" && (
        <TextPrompt
          title="名前を変更します"
          target={user.key}
          label="新しい名前"
          initial={user.name}
          note={pg ? undefined : "接続元はそのまま引き継ぎます"}
          onDecide={(v) => {
            setOpen(null);
            onAsk({
              title: "名前を変更します",
              change: { kind: "rename", user: who, name: v },
              confirmLabel: "変更する",
              done: `${user.name} の名前を「${v}」に変更しました`,
            });
          }}
          onCancel={() => setOpen(null)}
        />
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

  const go = () => value && onDecide(value);

  return (
    <ModalFrame
      title={title}
      target={target}
      onClose={onCancel}
      className="ddl-confirm"
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel}>
            キャンセル
          </button>
          <button className="btn-primary" onClick={go} disabled={!value}>
            次へ
          </button>
        </>
      }
    >
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
    </ModalFrame>
  );
}
