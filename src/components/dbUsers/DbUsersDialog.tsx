/**
 * DBのユーザー (PostgreSQL ではロール) と、その権限を見る・変える画面。
 *
 * 左でユーザーを選び、右にそのユーザーが持つ権限を出す。
 *
 * 権限が足りない接続でも、見えるぶんだけを出して断り書きを添える
 * (「何も出ない」と「権限が無くて見えない」を取り違えないため)。
 * 作成・変更ができない接続では、そのボタン自体を出さない
 */
import { useEffect, useMemo, useState } from "react";
import { dbPrivileges, dbUserGrants, listDbUsers } from "../../api";
import { useModal } from "../../hooks/useModal";
import type {
  DbPrivilegeChoices,
  DbType,
  DbUser,
  DbUsersInfo,
} from "../../types";
import { ChangeConfirm } from "./ChangeConfirm";
import { DbUsersHelp } from "./DbUsersHelp";
import { UserActions } from "./UserActions";
import type { AskedChange } from "./UserActions";
import { UserForm } from "./UserForm";
import { UserGrants } from "./UserGrants";
import { filterUsers, userLabel } from "./dbUserView";

interface Props {
  sessionId: string;
  database: string;
  /** 接続先のデータベース一覧 (権限の対象を選ばせるのに使う) */
  databases: string[];
  dbType: DbType;
  onClose: () => void;
}

export function DbUsersDialog({
  sessionId,
  database,
  databases,
  dbType,
  onClose,
}: Props) {
  const [info, setInfo] = useState<DbUsersInfo | null>(null);
  const [choices, setChoices] = useState<DbPrivilegeChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /** サーバーが用意したユーザーも出すか */
  const [withSystem, setWithSystem] = useState(false);
  /** 選んでいるユーザーの呼び名 */
  const [picked, setPicked] = useState<string | null>(null);
  /** 作る画面を開いているか */
  const [adding, setAdding] = useState(false);
  /** SQLを見せて確かめているところ */
  const [asked, setAsked] = useState<AskedChange | null>(null);
  /** 権限を引き直すきっかけ */
  const [refresh, setRefresh] = useState(0);
  /** ヘルプを開いているか */
  const [help, setHelp] = useState(false);
  const boxRef = useModal(onClose, !asked && !adding && !help);

  const pg = dbType === "postgresql";
  /** この画面での呼び方 (PostgreSQL にはユーザーとグループの区別が無い) */
  const word = pg ? "ロール" : "ユーザー";

  const reload = () => {
    listDbUsers(sessionId, database)
      .then((v) => {
        setInfo(v);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  };

  useEffect(reload, [sessionId, database]);

  // 権限の選択肢は接続ごとに決まるので、一度だけ取る
  useEffect(() => {
    dbPrivileges(sessionId)
      .then(setChoices)
      .catch(() => setChoices(null));
  }, [sessionId]);

  // 実行の知らせは数秒で消す (押した操作の確認なので残し続けない)
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const shown = useMemo(
    () => filterUsers(info?.users ?? [], filter, withSystem),
    [info, filter, withSystem]
  );

  // 一覧が変わったら、選んでいたものが消えていないか見て選び直す
  useEffect(() => {
    if (shown.length === 0) {
      setPicked(null);
      return;
    }
    if (picked && shown.some((u) => u.key === picked)) return;
    setPicked((shown.find((u) => u.isSelf) ?? shown[0]).key);
  }, [shown, picked]);

  const current = shown.find((u) => u.key === picked) ?? null;
  const canManage = info?.canManage ?? false;

  /**
   * 変更が済んだあとの後始末。
   *
   * 名前が変わったり消えたりすると、選んでいた呼び名は無くなるので
   * 選び直させる (一覧を取り直したあとに先頭が選ばれる)
   */
  const finish = (ask: AskedChange) => {
    const gone = ask.change.kind === "rename" || ask.change.kind === "drop";
    setAsked(null);
    setNotice(ask.done);
    if (gone) setPicked(null);
    setRefresh((v) => v + 1);
    reload();
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal dbusers-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            {word}と権限
            <span className="column-modal-target mono">{database}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="dbusers-toolbar">
          <input
            className="routine-filter"
            value={filter}
            placeholder="絞り込み (名前 / 接続元 / ロール)"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="switch">
            <input
              type="checkbox"
              checked={withSystem}
              onChange={(e) => setWithSystem(e.target.checked)}
            />
            <span className="track" aria-hidden />
            <span className="switch-label">サーバー既定のものも出す</span>
          </label>
          <span className="query-meta mono">{shown.length} 件</span>
          <button
            className="btn-secondary dbusers-help-btn has-tooltip"
            data-tooltip="MySQLとPostgreSQLの違いや、権限の意味"
            aria-label="ヘルプ"
            onClick={() => setHelp(true)}
          >
            ?
          </button>
          {canManage && (
            <button className="btn-primary" onClick={() => setAdding(true)}>
              {word}を作る
            </button>
          )}
          <button className="btn-secondary" onClick={reload}>
            更新
          </button>
        </div>

        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <span className="result-detail">{error}</span>
          </div>
        )}
        {info?.note && <div className="process-notice">{info.note}</div>}
        {notice && <div className="process-notice">{notice}</div>}

        <div className="dbusers-body">
          {info === null && !error ? (
            <div className="routine-empty">
              <span className="spinner accent" /> 読み込み中...
            </div>
          ) : (
            <>
              <div className="dbusers-list">
                {shown.length === 0 ? (
                  <div className="csv-empty-hint">出せる{word}がありません</div>
                ) : (
                  shown.map((u) => (
                    <UserRow
                      key={u.key}
                      user={u}
                      picked={u.key === picked}
                      onPick={() => setPicked(u.key)}
                    />
                  ))
                )}
              </div>
              <div className="dbusers-detail">
                {current ? (
                  <>
                    <UserGrants
                      sessionId={sessionId}
                      database={database}
                      user={current}
                      pg={pg}
                      canManage={canManage}
                      choices={choices}
                      databases={databases}
                      load={dbUserGrants}
                      onAsk={setAsked}
                      refresh={refresh}
                    />
                    {canManage && (
                      <UserActions
                        // ユーザーを選び替えたら、開きかけの入力は閉じる
                        key={current.key}
                        user={current}
                        pg={pg}
                        database={database}
                        onAsk={setAsked}
                      />
                    )}
                  </>
                ) : (
                  <div className="csv-empty-hint">
                    左から{word}を選んでください
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <p className="process-hint">
          {canManage
            ? "変更はすぐにサーバーへ反映されます (取り消しはできません)。実行したSQLはSQLコンソールで確かめられます。"
            : info?.manageNote ||
              "この接続では見るだけです (作成・変更はできません)。"}
          {pg
            ? " データベースとロールはサーバー全体で1つですが、スキーマ・テーブル・列の権限は、今つないでいるデータベースのぶんだけが出ます。"
            : " ユーザーは「名前と接続元ホスト」の2つ組で1人になります。"}
        </p>

        {adding && (
          <UserForm
            pg={pg}
            onDecide={(spec) => {
              setAdding(false);
              setAsked({
                title: `${word}を作ります`,
                change: { kind: "create", spec },
                confirmLabel: "作る",
                done: `「${spec.name}」を作りました`,
              });
            }}
            onCancel={() => setAdding(false)}
          />
        )}

        {help && (
          <DbUsersHelp
            pg={pg}
            choices={choices}
            onClose={() => setHelp(false)}
          />
        )}

        {asked && (
          <ChangeConfirm
            sessionId={sessionId}
            database={asked.database ?? database}
            title={asked.title}
            target={current ? current.key : database}
            change={asked.change}
            note={asked.note}
            typeName={asked.typeName}
            confirmLabel={asked.confirmLabel}
            onDone={() => finish(asked)}
            onCancel={() => setAsked(null)}
          />
        )}
      </div>
    </div>
  );
}

/** 左の一覧の1行 */
function UserRow({
  user,
  picked,
  onPick,
}: {
  user: DbUser;
  picked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      className={
        "dbusers-row" +
        (picked ? " picked" : "") +
        (user.canLogin ? "" : " is-role")
      }
      onClick={onPick}
    >
      <span className="dbusers-name mono">{userLabel(user)}</span>
      <span className="dbusers-marks">
        {user.isSelf && <span className="dbusers-self">この接続</span>}
        {user.badges.map((b) => (
          <span className="dbusers-badge" key={b}>
            {b}
          </span>
        ))}
      </span>
    </button>
  );
}
