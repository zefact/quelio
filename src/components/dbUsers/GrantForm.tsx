/**
 * 権限を1つ付ける画面。
 *
 * 選べる権限はバックエンドの決め打ちの一覧から受け取る。
 * 画面で作った選択肢と、実際に付けられるものがずれないようにするため。
 *
 * 対象は上から順に選んでいく:
 *   データベース → (PostgreSQLはスキーマ) → テーブル
 * 打ち間違いは静かに通ってしまうことがあり
 * (MySQLは存在しないデータベースにも権限を付けられる)、
 * あとから「効いていない」に気づきにくいため、一覧から選ばせる。
 *
 * 一覧を引けなかったときだけ、手で入力できる欄に切り替える
 * (権限が足りないと引けないことがあり、そこで手が止まらないように)
 */
import { useEffect, useMemo, useState } from "react";
import { listSchemas, listTables } from "../../api";
import { useModal } from "../../hooks/useModal";
import { SelectMenu } from "../SelectMenu";
import { noteFor } from "./dbUserHelp";
import type {
  DbGrantSpec,
  DbGrantTarget,
  DbPrivilegeChoices,
  TableInfo,
} from "../../types";

interface Props {
  sessionId: string;
  /** PostgreSQL か */
  pg: boolean;
  /** 今つないでいるデータベース (対象の初期値に使う) */
  database: string;
  /** 接続先のデータベース一覧 (対象を選ばせるのに使う) */
  databases: string[];
  /** 誰に付けるのか (見出しに出す) */
  who: string;
  choices: DbPrivilegeChoices;
  /**
   * 決まった内容を渡す (実行はしない。次の確認でSQLを見せる)。
   *
   * `database` は、そのSQLを流すデータベース。
   * PostgreSQLはスキーマやテーブルへの権限を
   * 「そのデータベースへ繋いだ状態」でしか付けられないため一緒に渡す
   */
  onDecide: (spec: DbGrantSpec, database: string) => void;
  onCancel: () => void;
}

/** 範囲の名前 */
const SCOPES: { value: DbGrantTarget; label: string }[] = [
  { value: "server", label: "サーバー全体" },
  { value: "database", label: "データベース" },
  { value: "schema", label: "スキーマ" },
  { value: "table", label: "テーブル" },
];

/** 一覧を引いた結果 (items が null は読み込み中、failed は引けなかった) */
interface Loaded<T> {
  items: T[] | null;
  failed: boolean;
}

const LOADING: Loaded<never> = { items: null, failed: false };

/** そのテーブルが入っているスキーマ */
function schemaOf(t: TableInfo): string {
  return t.schema ?? "public";
}

export function GrantForm({
  sessionId,
  pg,
  database,
  databases,
  who,
  choices,
  onDecide,
  onCancel,
}: Props) {
  /** その範囲で選べる権限が1つも無ければ、そもそも出さない */
  const usable = SCOPES.filter((s) => choices[s.value].length > 0);
  const [scope, setScope] = useState<DbGrantTarget>(
    usable[0]?.value ?? "database"
  );
  /** 対象のデータベース (サーバー全体のとき以外は必ず選ぶ) */
  const [db, setDb] = useState(database);
  /** 対象のスキーマ (PostgreSQLのみ) */
  const [schema, setSchema] = useState("");
  /** 対象のテーブル */
  const [table, setTable] = useState("");
  /** そのデータベースのスキーマ (スキーマの範囲で使う) */
  const [schemas, setSchemas] = useState<Loaded<string>>(LOADING);
  /** そのデータベースのテーブル (テーブルの範囲で使う) */
  const [found, setFound] = useState<Loaded<TableInfo>>(LOADING);
  const [picked, setPicked] = useState<string[]>([]);
  const [grantable, setGrantable] = useState(false);
  const boxRef = useModal(onCancel);

  const privileges = choices[scope];

  /** スキーマの一覧を引く先 (要らない場面では空) */
  const schemaFrom = pg && scope === "schema" ? db : "";

  useEffect(() => {
    if (!schemaFrom) return;
    let alive = true;
    setSchemas(LOADING);
    listSchemas(sessionId, schemaFrom)
      .then((v) => {
        if (!alive) return;
        setSchemas({ items: v, failed: false });
        setSchema((s) => (v.includes(s) ? s : (v[0] ?? "")));
      })
      .catch(() => alive && setSchemas({ items: [], failed: true }));
    return () => {
      alive = false;
    };
  }, [schemaFrom, sessionId]);

  /** テーブルの一覧を引く先 (要らない場面では空) */
  const tableFrom = scope === "table" ? db : "";

  useEffect(() => {
    if (!tableFrom) {
      setFound(LOADING);
      return;
    }
    let alive = true;
    setFound(LOADING);
    listTables(sessionId, tableFrom)
      .then((v) => alive && setFound({ items: v, failed: false }))
      .catch(() => alive && setFound({ items: [], failed: true }));
    return () => {
      alive = false;
    };
  }, [tableFrom, sessionId]);

  /** テーブルがあるスキーマだけを候補にする (PostgreSQL) */
  const tableSchemas = useMemo(() => {
    if (!pg || !found.items) return [];
    return [...new Set(found.items.map(schemaOf))].sort();
  }, [pg, found]);

  // 引いてきたスキーマの中に今の指定が無ければ、先頭へ寄せる
  useEffect(() => {
    if (scope !== "table" || !pg || tableSchemas.length === 0) return;
    setSchema((s) => (tableSchemas.includes(s) ? s : tableSchemas[0]));
  }, [scope, pg, tableSchemas]);

  /** 今のスキーマに入っているテーブル */
  const tableNames = useMemo(() => {
    if (!found.items) return [];
    return found.items
      .filter((t) => !pg || schemaOf(t) === schema)
      .map((t) => t.name);
  }, [found, pg, schema]);

  // 選んでいたテーブルが、選び直しで無くなったら外す
  useEffect(() => {
    setTable((t) => (t && tableNames.includes(t) ? t : ""));
  }, [tableNames]);

  /**
   * バックエンドへ渡す対象。
   *
   * テーブルは「入れ物.テーブル」の形で、
   * 入れ物はMySQLならデータベース、PostgreSQLならスキーマ
   */
  const target = useMemo(() => {
    if (scope === "server") return "";
    if (scope === "schema") return schema;
    if (scope === "table") {
      const box = pg ? schema : db;
      return box && table ? `${box}.${table}` : "";
    }
    return db;
  }, [scope, pg, db, schema, table]);

  const toggle = (p: string) =>
    setPicked((v) => (v.includes(p) ? v.filter((x) => x !== p) : [...v, p]));

  /** 範囲を変えると、選んでいた権限はその範囲では使えないことがある */
  const pickScope = (v: string) => {
    setScope(v as DbGrantTarget);
    setPicked([]);
    setTable("");
  };

  const ready = picked.length > 0 && (scope === "server" || !!target);

  const go = () => {
    if (!ready) return;
    onDecide({ scope, target, privileges: picked, grantable }, db);
  };

  const dbList: Loaded<string> = { items: databases, failed: false };
  /** テーブルを選ぶときのスキーマは、テーブルの一覧から作る */
  const tableSchemaList: Loaded<string> = {
    items: found.items ? tableSchemas : null,
    failed: found.failed,
  };

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div
        className="modal dbusers-form"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            権限を付ける
            <span className="column-modal-target mono">{who}</span>
          </span>
          <button className="modal-close" onClick={onCancel} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="form-grid">
          <div className="form-field span2">
            <span className="field-label">範囲</span>
            <SelectMenu
              // モーダルは中でスクロールするので、選択肢が切られないよう窓基準で出す
              popFixed
              className="select-field"
              value={scope}
              options={usable.map((s) => ({ value: s.value, label: s.label }))}
              onChange={pickScope}
            />
          </div>

          {scope !== "server" && (
            <div
              className={
                "form-field" + (scope === "database" ? " span2" : "")
              }
            >
              <span className="field-label">データベース</span>
              <Picker
                value={db}
                loaded={dbList}
                placeholder="データベース名"
                onChange={(v) => {
                  setDb(v);
                  setSchema("");
                  setTable("");
                }}
              />
            </div>
          )}

          {pg && (scope === "schema" || scope === "table") && (
            <div className="form-field">
              <span className="field-label">スキーマ</span>
              <Picker
                value={schema}
                loaded={scope === "schema" ? schemas : tableSchemaList}
                placeholder="スキーマ名"
                onChange={(v) => {
                  setSchema(v);
                  setTable("");
                }}
              />
            </div>
          )}

          {scope === "table" && (
            <div className="form-field span2">
              <span className="field-label">テーブル</span>
              <Picker
                value={table}
                loaded={{
                  items: found.items ? tableNames : null,
                  failed: found.failed,
                }}
                placeholder="テーブル名"
                onChange={setTable}
              />
            </div>
          )}

          <div className="form-field span2">
            <div className="dbusers-privs-head">
              <span className="field-label">権限</span>
              <span className="dbusers-pick-all">
                <button
                  className="btn-ghost"
                  disabled={picked.length === privileges.length}
                  onClick={() => setPicked([...privileges])}
                >
                  すべて選ぶ
                </button>
                <button
                  className="btn-ghost"
                  disabled={picked.length === 0}
                  onClick={() => setPicked([])}
                >
                  すべて外す
                </button>
              </span>
            </div>
            <div className="dbusers-checks wide">
              {privileges.map((p) => (
                <label
                  className="dbusers-check"
                  key={p}
                  title={noteFor(p, pg) || undefined}
                >
                  <input
                    type="checkbox"
                    checked={picked.includes(p)}
                    onChange={() => toggle(p)}
                  />
                  <span className="mono">{p}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="dbusers-check span2">
            <input
              type="checkbox"
              checked={grantable}
              onChange={(e) => setGrantable(e.target.checked)}
            />
            この権限を他の人へ渡せるようにする (WITH GRANT OPTION)
          </label>
        </div>

        {pg && scope !== "server" && scope !== "database" && db !== database && (
          <p className="field-note">
            「{db}」へ接続し直してから実行します
            (PostgreSQLは、そのデータベースに繋いだ状態でないと
            スキーマやテーブルへの権限を付けられません)
          </p>
        )}

        <div className="form-actions">
          <button className="btn-secondary" onClick={onCancel}>
            やめる
          </button>
          <button className="btn-primary" onClick={go} disabled={!ready}>
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 一覧から選ばせる。
 *
 * 引けなかったときだけ手で入力させる。
 * 「1つも無い」と「引けなかった」は別のことなので、
 * 空の一覧はそのまま選択肢なしとして出す
 */
function Picker({
  value,
  loaded,
  placeholder,
  onChange,
}: {
  value: string;
  loaded: Loaded<string>;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  if (loaded.failed) {
    return (
      <input
        className="text-field mono"
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <SelectMenu
      // データベースやテーブルは数が多い。モーダルの外へはみ出して出す
      popFixed
      className="select-field mono"
      value={value}
      placeholder={loaded.items ? placeholder : "読み込み中..."}
      disabled={!loaded.items}
      options={(loaded.items ?? []).map((v) => ({ value: v, label: v }))}
      onChange={onChange}
    />
  );
}
