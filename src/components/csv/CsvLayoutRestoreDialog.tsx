/**
 * お気に入り (固定長の桁設定・列名の並び) の復元 (ファイルから選んで取り込む)。
 *
 * 今あるお気に入りは1件も書き換えない
 * (同じ名前のものを上書きする、設定画面の復元とはここが違う)。
 * ファイルのフォルダ分けはそのまま足し、名前が重なるものには
 * 「名前 (2)」のように番号を付ける (お気に入りもフォルダも)。
 * 付ける名前は取り込む前に行ごとに見せる。
 * 呼び名・読み込む関数は種類ごとに `kind` で受け取る
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { CsvLayoutFileEntry, CsvLayoutImported } from "../../types";
import { ModalFrame } from "../ModalFrame";
import { FolderIcon } from "../sqlLibrary/LibraryIcons";
import { TreeIndent } from "../sqlLibrary/TreeIndent";
import { TriCheckbox } from "../sqlLibrary/TriCheckbox";
import type { FavKind } from "./csvFavKinds";
import type { Named } from "./csvLayoutTree";
import { restoreGroups, togglePick } from "./csvLayoutPick";

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

interface Props<T extends Named> {
  /** お気に入りの種類 (呼び名・読み込む関数) */
  kind: FavKind<T>;
  onClose: () => void;
  /** 取り込んだあと (一覧を読み直して知らせる) */
  onDone: (done: CsvLayoutImported[]) => void;
}

/** パスの末尾 (ファイル名) */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function CsvLayoutRestoreDialog<T extends Named>({
  kind,
  onClose,
  onDone,
}: Props<T>) {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<CsvLayoutFileEntry[] | null>(null);
  /** 選んでいるもの (ファイルの中での名前) */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** ファイルを選んで、中のお気に入りを確かめる (最初は全部に印を付ける) */
  const pick = async () => {
    const chosen = await open({
      multiple: false,
      filters: JSON_FILTER,
      title: `${kind.label}を復元`,
    }).catch(() => null);
    if (typeof chosen !== "string") return;
    setError(null);
    setEntries(null);
    setPath(chosen);
    try {
      const list = await kind.inspectFile(chosen);
      setEntries(list);
      setSel(new Set(list.map((e) => e.name)));
    } catch (e) {
      setError(String(e));
    }
  };

  // 開いたらすぐファイルを選べるようにする (やめたらボタンから選び直せる)
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void pick();
    // 開いたときに1回だけ選ばせる (種類 kind は開いている間に変わらない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => restoreGroups(entries ?? []), [entries]);
  const picked = entries?.filter((e) => sel.has(e.name)) ?? [];
  const canRun = path !== null && picked.length > 0 && !busy;

  const run = async () => {
    if (!canRun || path === null) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await kind.importAsNew(path, picked.map((e) => e.name)));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  /** フォルダの印 (中身から決まる) と、押したときの切り替え */
  const groupState = (names: string[]) => {
    const n = names.filter((x) => sel.has(x)).length;
    return n === 0 ? "none" : n === names.length ? "all" : "some";
  };
  const toggleGroup = (names: string[]) =>
    setSel((s) => {
      const next = new Set(s);
      const all = names.every((x) => next.has(x));
      for (const x of names) {
        if (all) next.delete(x);
        else next.add(x);
      }
      return next;
    });

  /** お気に入り1件の行 */
  const itemRow = (e: CsvLayoutFileEntry, depth: number) => (
    <label key={e.name} className="pick-row">
      <TreeIndent depth={depth} />
      <input
        type="checkbox"
        className="pick-check"
        checked={sel.has(e.name)}
        onChange={() => setSel((s) => togglePick(s, e.name))}
      />
      {kind.icon()}
      <span className="er-pick-text">
        <span className="pick-name">{e.name}</span>
        {e.saveAs !== e.name && (
          // 同じ名前のお気に入りがあるので、番号を付けた名前で足す
          <span className="er-pick-rename pick-name">
            同じ名前があるので「{e.saveAs}」として追加
          </span>
        )}
      </span>
      <span className="er-pick-meta">
        {e.columns}
        {kind.unit}
      </span>
    </label>
  );

  return (
    <ModalFrame
      title={`${kind.label}を復元 (今あるものに追加)`}
      onClose={onClose}
      closable={!busy}
      className="saved-transfer-modal"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={!canRun}
            onClick={() => void run()}
          >
            {picked.length > 0 ? `${picked.length}件を追加する` : "追加する"}
          </button>
        </>
      }
    >

      <div className="saved-transfer-body">
        <div className="save-sql-label">
          ファイル
          <div className="restore-file">
            <span className="restore-file-name mono" title={path ?? ""}>
              {path ? baseName(path) : "(選んでいません)"}
            </span>
            <button
              type="button"
              className="btn-ghost folder-pick-add"
              disabled={busy}
              onClick={() => void pick()}
            >
              {path ? "選び直す…" : "ファイルを選ぶ…"}
            </button>
          </div>
        </div>

        {entries && entries.length === 0 && (
          <span className="save-sql-note">
            このファイルには{kind.label}がありません
          </span>
        )}
        {entries && entries.length > 0 && (
          <>
            <div className="pick-head">
              <span className="pick-count">
                {entries.length}件中 {picked.length}件を追加します
              </span>
              <span className="toolbar-spacer" />
              <button
                type="button"
                className="lib-action"
                onClick={() => setSel(new Set(entries.map((e) => e.name)))}
              >
                すべて選ぶ
              </button>
              <button
                type="button"
                className="lib-action"
                onClick={() => setSel(new Set())}
              >
                すべて外す
              </button>
            </div>
            <div className="pick-list">
              {groups.flatMap((g, i) => {
                if (g.folder === null) return g.entries.map((e) => itemRow(e, 0));
                const names = g.entries.map((e) => e.name);
                return [
                  <label key={`f:${i}`} className="pick-row pick-folder">
                    <TriCheckbox
                      state={groupState(names)}
                      onChange={() => toggleGroup(names)}
                    />
                    <FolderIcon open />
                    <span className="er-pick-text">
                      <span className="pick-name">
                        {g.renamedFrom ?? g.folder}
                      </span>
                      {g.renamedFrom !== null && (
                        <span className="er-pick-rename pick-name">
                          同じ名前のフォルダがあるので「{g.folder}」として追加
                        </span>
                      )}
                    </span>
                    <span className="saved-folder-count">{g.entries.length}</span>
                  </label>,
                  ...g.entries.map((e) => itemRow(e, 1)),
                ];
              })}
            </div>
          </>
        )}

        <p className="restore-safe">
          今あるお気に入りは変わりません
          (同じ名前のものは上書きせず、番号を付けて足します)。
        </p>

        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error}</span>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
