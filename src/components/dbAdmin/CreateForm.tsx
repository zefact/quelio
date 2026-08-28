import { useEffect, useMemo, useState } from "react";
import { listCharsets, previewCreateDatabase, previewCreateSchema } from "../../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { SelectMenu } from "../SelectMenu";
import type { CharsetInfo, DbType } from "../../types";
import type { AdminKind } from "./DbAdminDialog";

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 作るものの名前 */
  kind: AdminKind;
  /** 文字コードの指定欄を出すか (データベースのときだけ) */
  withEncoding: boolean;
  disabled: boolean;
  /** 実行中かどうかを親へ伝える (閉じさせないため) */
  onBusyChange: (busy: boolean) => void;
  /** 作成する。失敗したら例外を投げること */
  onCreate: (
    name: string,
    encoding?: string,
    collation?: string
  ) => Promise<void>;
}

/** 「選ばない」を表す値 (サーバーの既定に任せる) */
const DEFAULT = "";

/**
 * 名前 (と文字コード) を入れて作るフォーム。
 *
 * DDLなので、Enterや「作成」ですぐには流さず確認をはさむ。
 * 実行するSQLをそのまま見せてから決めてもらう
 */
export function CreateForm({
  sessionId,
  dbType,
  kind,
  withEncoding,
  disabled,
  onBusyChange,
  onCreate,
}: Props) {
  const [name, setName] = useState("");
  const [encoding, setEncoding] = useState(DEFAULT);
  const [collation, setCollation] = useState(DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [charsets, setCharsets] = useState<CharsetInfo[]>([]);
  /** 確認中の内容 (実行するSQL) */
  const [pending, setPending] = useState<string | null>(null);

  // 選べる文字コードはサーバーに聞く (綴りを手で打たせない)
  useEffect(() => {
    if (!withEncoding) return;
    let alive = true;
    listCharsets(sessionId)
      .then((list) => {
        if (alive) setCharsets(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, withEncoding]);

  const encodingOptions = useMemo(
    () => [
      { value: DEFAULT, label: "既定のまま" },
      ...charsets.map((c) => ({
        value: c.name,
        label: c.description ? `${c.name} — ${c.description}` : c.name,
      })),
    ],
    [charsets]
  );

  /** 照合順序は文字コードに属するので、選ばれているものだけを出す */
  const selected = charsets.find((c) => c.name === encoding);
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

  const trimmed = name.trim();
  const canGo = !!trimmed && !busy && !disabled;

  /** 実行するSQLを組み立てて確認を出す (ここではまだ実行しない) */
  const ask = async () => {
    if (!canGo) return;
    setError(null);
    try {
      const sql =
        kind === "スキーマ"
          ? await previewCreateSchema(dbType, trimmed)
          : await previewCreateDatabase(
              dbType,
              trimmed,
              encoding || undefined,
              collation || undefined
            );
      setPending(sql);
    } catch (e) {
      // 名前が長すぎる等はここで分かる (実行前に気づける)
      setError(String(e));
    }
  };

  const run = async () => {
    setBusy(true);
    onBusyChange(true);
    try {
      await onCreate(trimmed, encoding || undefined, collation || undefined);
      setName("");
      setEncoding(DEFAULT);
      setCollation(DEFAULT);
      setPending(null);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };

  return (
    <div className="db-admin-create">
      {/* 何を作るかは節の見出し (データベース / スキーマ) に出ている */}
      <h4 className="db-admin-subtitle">新しく作る</h4>
      <div className="db-admin-row">
        <input
          className="text-field mono db-admin-name"
          value={name}
          spellCheck={false}
          disabled={disabled || busy}
          placeholder={`新しい${kind}の名前`}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // 日本語入力の変換確定のEnterで確認を開かない
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") void ask();
          }}
        />
        <button className="btn-primary" disabled={!canGo} onClick={ask}>
          {busy ? "作成中..." : "作成"}
        </button>
      </div>

      {/* 指定は任意なので、名前とは別の行に分けて置く */}
      {withEncoding && (
        <div className="db-admin-opts-row">
          <label className="db-admin-opt-field">
            <span className="db-admin-opt-label">
              {dbType === "mysql" ? "文字コード" : "エンコーディング"}
            </span>
            <SelectMenu
              className="select-field mono"
              value={encoding}
              options={encodingOptions}
              disabled={disabled || busy}
              popFixed
              onChange={(v) => {
                setEncoding(v);
                // 前の文字コードの照合順序が残らないようにする
                setCollation(DEFAULT);
              }}
            />
          </label>
          {dbType === "mysql" && (
            <label className="db-admin-opt-field">
              <span className="db-admin-opt-label">照合順序</span>
              <SelectMenu
                className="select-field mono"
                value={collation}
                options={collationOptions}
                // 照合順序は文字コードに属するので、先に文字コードを選んでもらう
                disabled={disabled || busy || !selected}
                placeholder={
                  selected ? "既定のまま" : "先に文字コードを選んでください"
                }
                popFixed
                onChange={setCollation}
              />
            </label>
          )}
        </div>
      )}

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <span className="result-detail">{error}</span>
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title={`${kind}を作成します`}
          target={trimmed}
          confirmLabel="作成する"
          onConfirm={run}
          onCancel={() => setPending(null)}
        >
          <p>次のSQLを実行します。</p>
          <pre className="mono confirm-sql">{pending}</pre>
        </ConfirmDialog>
      )}
    </div>
  );
}
