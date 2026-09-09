/**
 * 選んだユーザーが持つ権限の一覧と、その付け外し。
 *
 * ユーザーを選び替えるたびに引き直すので、
 * 一覧本体 (DbUsersDialog) とは分けてある
 */
import { useEffect, useState } from "react";
import type { DbGrant, DbPrivilegeChoices, DbUser } from "../../types";
import { GrantForm } from "./GrantForm";
import type { AskedChange } from "./UserActions";
import { SCOPE_HELP, noteFor } from "./dbUserHelp";
import {
  SCOPE_LABEL,
  blockedReason,
  groupGrants,
  revokeNote,
  revokeSpec,
  userRef,
} from "./dbUserView";
import type { GrantGroup } from "./dbUserView";

interface Props {
  sessionId: string;
  database: string;
  user: DbUser;
  /** PostgreSQL か (断り書きの文言を変える) */
  pg: boolean;
  /** この接続で権限を変えられるか */
  canManage: boolean;
  /** 範囲ごとに選べる権限 (取れていなければ null) */
  choices: DbPrivilegeChoices | null;
  /** 接続先のデータベース一覧 (権限の対象を選ばせるのに使う) */
  databases: string[];
  /** 権限を引く手立て (試験で差し替えられるように受け取る) */
  load: (
    sessionId: string,
    database: string,
    key: string
  ) => Promise<DbGrant[]>;
  /** 確認へ進む */
  onAsk: (ask: AskedChange) => void;
  /** 権限を引き直すきっかけ (変更のあとに増やす) */
  refresh: number;
}

export function UserGrants({
  sessionId,
  database,
  user,
  pg,
  canManage,
  choices,
  databases,
  load,
  onAsk,
  refresh,
}: Props) {
  const [groups, setGroups] = useState<GrantGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 付ける画面を開いているか */
  const [adding, setAdding] = useState(false);
  const blocked = blockedReason(user);
  const editable = canManage && !blocked;

  useEffect(() => {
    let alive = true;
    setGroups(null);
    setError(null);
    load(sessionId, database, user.key)
      .then((v) => {
        // 選び替えが速いと、前の結果が後から届くことがある
        if (alive) setGroups(groupGrants(v));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId, database, user.key, load, refresh]);

  return (
    <div className="dbusers-grants">
      <div className="dbusers-head">
        <span className="dbusers-head-name mono">{user.key}</span>
        <span className="dbusers-head-note">
          {user.canLogin ? "ログインできます" : "ログインしないロールです"}
          {user.auth && ` / 認証: ${user.auth}`}
          {user.connLimit && ` / 同時接続 ${user.connLimit}まで`}
          {user.expires && ` / 期限 ${user.expires}`}
        </span>
      </div>

      {user.memberOf.length > 0 && (
        <div className="dbusers-roles">
          所属ロール:{" "}
          {user.memberOf.map((r) => (
            <span className="dbusers-badge" key={r}>
              {r}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <span className="result-detail">{error}</span>
        </div>
      )}

      <div className="dbusers-grant-head">
        <span className="dbusers-grant-title">権限</span>
        {editable && choices && (
          <button className="btn-secondary" onClick={() => setAdding(true)}>
            権限を付ける
          </button>
        )}
      </div>

      {groups === null && !error ? (
        <div className="routine-empty">
          <span className="spinner accent" /> 読み込み中...
        </div>
      ) : (
        <div className="dbusers-grant-list">
          {(groups ?? []).length === 0 ? (
            <div className="csv-empty-hint">
              直接与えられた権限はありません
              {user.memberOf.length > 0 &&
                " (所属ロールの権限は、そのロールを選ぶと見られます)"}
            </div>
          ) : (
            (groups ?? []).map((g) => (
              <div className="dbusers-grant" key={`${g.scope} ${g.target}`}>
                <span className="dbusers-scope" title={SCOPE_HELP[g.scope]}>
                  {SCOPE_LABEL[g.scope]}
                </span>
                <span className="dbusers-target mono">{g.target}</span>
                <span className="dbusers-privs">
                  {g.privileges.map((p) => (
                    <span
                      className="dbusers-priv"
                      key={p}
                      title={noteFor(p, pg) || undefined}
                    >
                      {p}
                    </span>
                  ))}
                  {g.grantable && (
                    <span className="dbusers-priv grantable">他人に渡せる</span>
                  )}
                </span>
                {editable && (
                  <button
                    className="btn-ghost dbusers-revoke"
                    disabled={!revokeSpec(g, pg)}
                    title={
                      revokeSpec(g, pg)
                        ? "この権限を取り消す"
                        : "この権限は、この画面では外せません"
                    }
                    onClick={() => {
                      const spec = revokeSpec(g, pg);
                      if (!spec) return;
                      onAsk({
                        title: "権限を取り消します",
                        change: {
                          kind: "grant",
                          user: userRef(user),
                          spec,
                          add: false,
                        },
                        note: revokeNote(g, pg),
                        confirmLabel: "取り消す",
                        done: "権限を取り消しました",
                      });
                    }}
                  >
                    取り消す
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {pg && (
        <p className="dbusers-foot">
          スキーマ・テーブル・列の権限は「{database}」のぶんだけです。
          ほかのデータベースのぶんは、そちらへ接続すると見られます
        </p>
      )}

      {adding && choices && (
        <GrantForm
          sessionId={sessionId}
          pg={pg}
          database={database}
          databases={databases}
          who={user.key}
          choices={choices}
          onDecide={(spec, on) => {
            setAdding(false);
            onAsk({
              title: "権限を付けます",
              change: { kind: "grant", user: userRef(user), spec, add: true },
              confirmLabel: "付ける",
              database: on,
              done: "権限を付けました",
            });
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}
