import { useEffect, useMemo, useState } from "react";
import {
  createTable,
  listCharsets,
  listColumnTypes,
  previewCreateTable,
} from "../../api";
import { useModal } from "../../hooks/useModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { SelectMenu } from "../SelectMenu";
import { ColumnRows } from "./ColumnRows";
import { DraftColumn, firstColumns, toNewTable, validateDraft } from "./newTable";
import type { CharsetInfo, DbType } from "../../types";

/** 「選ばない」を表す値 (サーバーの既定に任せる) */
const DEFAULT = "";

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 作る先のデータベース */
  database: string;
  /** 選べるスキーマ (PostgreSQLのみ) */
  schemas: string[];
  /** 最初に選んでおくスキーマ */
  defaultSchema?: string;
  onClose: () => void;
  /** 作成できた (一覧を取り直して、そのテーブルを開く) */
  onCreated: (schema: string | undefined, name: string) => void;
}

/**
 * テーブルを作る画面。
 *
 * DDLなのですぐには流さず、組み立てたSQLを見せてから実行する
 */
export function CreateTableModal({
  sessionId,
  dbType,
  database,
  schemas,
  defaultSchema,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [schema, setSchema] = useState(defaultSchema ?? "");
  const [columns, setColumns] = useState<DraftColumn[]>(() =>
    firstColumns(dbType)
  );
  const [charset, setCharset] = useState(DEFAULT);
  const [collation, setCollation] = useState(DEFAULT);
  const [comment, setComment] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [charsets, setCharsets] = useState<CharsetInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 確認中の内容 (実行するSQL) */
  const [pending, setPending] = useState<string | null>(null);
  const boxRef = useModal(onClose, !busy);

  const isMysql = dbType === "mysql";
  const isPg = dbType === "postgresql";
  const withComment = isMysql || isPg;

  // 型の候補はサーバーに聞く (綴りを手で打たせない)
  useEffect(() => {
    let alive = true;
    listColumnTypes(sessionId, database)
      .then((list) => {
        if (alive) setTypes(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, database]);

  useEffect(() => {
    if (!isMysql) return;
    let alive = true;
    listCharsets(sessionId)
      .then((list) => {
        if (alive) setCharsets(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, isMysql]);

  const charsetOptions = useMemo(
    () => [
      { value: DEFAULT, label: "データベースの既定" },
      ...charsets.map((c) => ({
        value: c.name,
        label: c.description ? `${c.name} — ${c.description}` : c.name,
      })),
    ],
    [charsets]
  );

  /** 照合順序は文字コードに属するので、選ばれているものだけを出す */
  const selected = charsets.find((c) => c.name === charset);
  const collationOptions = useMemo(
    () => [
      {
        value: DEFAULT,
        label: selected?.defaultCollation
          ? `既定のまま (${selected.defaultCollation})`
          : "既定のまま",
      },
      ...(selected?.collations ?? []).map((c) => ({ value: c, label: c })),
    ],
    [selected]
  );

  const spec = () =>
    toNewTable({
      schema: isPg ? schema : undefined,
      name,
      columns,
      charset: isMysql ? charset : undefined,
      collation: isMysql ? collation : undefined,
      comment: withComment ? comment : undefined,
    });

  /** 実行するSQLを組み立てて確認を出す (ここではまだ実行しない) */
  const ask = async () => {
    const ng = validateDraft(name, columns);
    if (ng) {
      setError(ng);
      return;
    }
    setError(null);
    try {
      setPending(await previewCreateTable(sessionId, database, spec()));
    } catch (e) {
      // 型やデフォルト値の書き方の誤りは、ここで分かる (実行前に気づける)
      setError(String(e));
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      await createTable(sessionId, database, spec());
      setPending(null);
      onCreated(isPg ? schema.trim() || undefined : undefined, name.trim());
    } finally {
      setBusy(false);
    }
  };

  const schemaOptions = useMemo(
    () => schemas.map((s) => ({ value: s, label: s })),
    [schemas]
  );

  return (
    <div className="modal-overlay" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal create-table-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            テーブルを作成
            <span className="column-modal-target mono">{database}</span>
          </span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={busy}
            title="閉じる (Esc)"
          >
            ×
          </button>
        </div>

        <div className="ct-body">
          <div className="db-admin-opts-row">
            {isPg && (
              <label className="db-admin-opt-field">
                <span className="db-admin-opt-label">スキーマ</span>
                <SelectMenu
                  className="select-field mono"
                  value={schema}
                  options={schemaOptions}
                  disabled={busy}
                  placeholder="public"
                  popFixed
                  onChange={setSchema}
                />
              </label>
            )}
            <label className="db-admin-opt-field ct-name-field">
              <span className="db-admin-opt-label">テーブル名</span>
              <input
                className="text-field mono"
                value={name}
                autoFocus
                spellCheck={false}
                disabled={busy}
                placeholder="新しいテーブルの名前"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {withComment && (
              <label className="db-admin-opt-field ct-comment-field">
                <span className="db-admin-opt-label">テーブルの説明</span>
                <input
                  className="text-field"
                  value={comment}
                  disabled={busy}
                  placeholder="日本語名など (任意)"
                  onChange={(e) => setComment(e.target.value)}
                />
              </label>
            )}
          </div>

          {isMysql && (
            <div className="db-admin-opts-row">
              <label className="db-admin-opt-field">
                <span className="db-admin-opt-label">文字コード</span>
                <SelectMenu
                  className="select-field mono"
                  value={charset}
                  options={charsetOptions}
                  disabled={busy}
                  popFixed
                  onChange={(v) => {
                    setCharset(v);
                    // 前の文字コードの照合順序が残らないようにする
                    setCollation(DEFAULT);
                  }}
                />
              </label>
              <label className="db-admin-opt-field">
                <span className="db-admin-opt-label">照合順序</span>
                <SelectMenu
                  className="select-field mono"
                  value={collation}
                  options={collationOptions}
                  // 照合順序は文字コードに属するので、先に文字コードを選んでもらう
                  disabled={busy || !selected}
                  placeholder={
                    selected ? "既定のまま" : "先に文字コードを選んでください"
                  }
                  popFixed
                  onChange={setCollation}
                />
              </label>
            </div>
          )}

          <ColumnRows
            dbType={dbType}
            columns={columns}
            types={types}
            disabled={busy}
            onChange={setColumns}
          />
        </div>

        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <span className="result-detail">{error}</span>
          </div>
        )}

        <div className="modal-actions column-modal-actions">
          <span className="ct-foot-hint">
            作成する前に、実行するSQLを確認できます
          </span>
          <span className="toolbar-spacer" />
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button className="btn-primary" disabled={busy} onClick={ask}>
            {busy ? "作成中..." : "作成"}
          </button>
        </div>

        {pending && (
          <ConfirmDialog
            title="テーブルを作成します"
            target={name.trim()}
            confirmLabel="作成する"
            onConfirm={run}
            onCancel={() => setPending(null)}
          >
            <p>次のSQLを実行します。</p>
            <pre className="mono confirm-sql">{pending}</pre>
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}
