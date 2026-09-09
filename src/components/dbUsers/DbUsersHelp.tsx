/**
 * ユーザーと権限のヘルプ。
 *
 * 「ユーザー」「権限」という言葉は同じでも、DBによって指しているものが違う。
 * ここに出すのは**今つないでいるDBの決まりだけ**にしてある。
 * 使っていないほうの説明を並べても、読む手間が増えるだけなので
 */
import { useModal } from "../../hooks/useModal";
import type { DbPrivilegeChoices } from "../../types";
import {
  noteFor,
  readOnlyPrivileges,
  rules,
  screenNotes,
} from "./dbUserHelp";

interface Props {
  /** PostgreSQL につないでいるか */
  pg: boolean;
  /** 範囲ごとに選べる権限 (取れていなければ null) */
  choices: DbPrivilegeChoices | null;
  onClose: () => void;
}

/** 権限の一覧に出す並び (無い範囲は出さない) */
const GROUPS: { key: keyof DbPrivilegeChoices; label: string }[] = [
  { key: "server", label: "サーバー全体に付けられるもの" },
  { key: "database", label: "データベースに付けられるもの" },
  { key: "schema", label: "スキーマに付けられるもの" },
  { key: "table", label: "テーブルに付けられるもの" },
];

export function DbUsersHelp({ pg, choices, onClose }: Props) {
  const boxRef = useModal(onClose);
  const here = pg ? "PostgreSQL" : "MySQL / MariaDB";
  const word = pg ? "ロール" : "ユーザー";

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal dbusers-help"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            {word}と権限について
            <span className="column-modal-target mono">{here}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <section className="dbusers-help-part">
          <h4>{here} の決まり</h4>
          <dl className="dbusers-help-rules">
            {rules(pg).map((r) => (
              <div className="dbusers-help-rule" key={r.about}>
                <dt>{r.about}</dt>
                <dd>{r.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="dbusers-help-part">
          <h4>この画面での扱い</h4>
          <ul className="dbusers-help-list">
            {screenNotes(pg).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>

        {choices && (
          <section className="dbusers-help-part">
            <h4>権限の意味</h4>
            {GROUPS.filter((g) => choices[g.key].length > 0).map((g) => (
              <div className="dbusers-help-group" key={g.key}>
                <span className="field-label">{g.label}</span>
                <dl className="dbusers-help-privs">
                  {choices[g.key].map((p) => (
                    <div className="dbusers-help-priv" key={p}>
                      <dt className="mono">{p}</dt>
                      <dd>{noteFor(p, pg) || "—"}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}

            {readOnlyPrivileges(pg).length > 0 && (
              <div className="dbusers-help-group">
                <span className="field-label">
                  一覧に出てくるが、付け外しできないもの
                </span>
                <dl className="dbusers-help-privs">
                  {readOnlyPrivileges(pg).map((p) => (
                    <div className="dbusers-help-priv" key={p}>
                      <dt className="mono">{p}</dt>
                      <dd>{noteFor(p, pg)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
