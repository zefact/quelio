/**
 * お気に入り (固定長の桁設定・列名の並び) の一覧を、フォルダ分けして並べる部品。
 *
 * 数が増えると探しにくいので、掴んで並べ替えたり、
 * フォルダを作ってまとめたりできる (フォルダは1階層まで)。
 * フォルダは行を押すと開閉し、閉じたものは次に開いたときも閉じたまま出す。
 * 上には「＋ フォルダ」「バックアップ」「復元」のボタンを並べる。
 *
 * お気に入り1件の行の見た目は、中身によって違うので呼び出す側が描く
 * (`renderItem`。渡される `hold` を行の onPointerDown に付けると掴めるようになる)。
 *
 * 掴む所は指の動き (pointer) で自前に作ってある。
 * このウィンドウはOSからのファイルの落とし込みを受けているので、
 * ブラウザ標準の掴み方 (draggable) を使うとそちらが先に反応してしまう。
 * 並べ方の計算は csvLayoutTree.ts に置いてある
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { FavNode } from "../../types";
import { CsvFavFolderRow } from "./CsvFavFolderRow";
import {
  loadClosed,
  pruneClosed,
  renameClosed,
  saveClosed,
  toggleClosed,
} from "./csvLayoutFold";
import {
  addFolder,
  applyMove,
  endSpot,
  folderNames,
  hitRow,
  removeFolder,
  renameFolder,
  rowsOf,
  spotAt,
  usedName,
  visibleRows,
} from "./csvLayoutTree";
import type { LayoutDrag, LayoutRow, LayoutSpot, Named } from "./csvLayoutTree";

/** お気に入り1件の行を描くときに渡すもの */
export interface FavItemCtx {
  /** フォルダの中にあるか (あれば縦線つきで1段下げる) */
  inFolder: boolean;
  /** 行に足すクラス (放す場所の目印) */
  mark: string;
  /** 掴んで動かした直後の「押した」を効かせないよう、押したときの動きを包む */
  tap: (act: () => void) => () => void;
  /** 行を押さえた (掴んで動かす用意)。行の onPointerDown に付ける */
  hold: (e: React.PointerEvent) => void;
}

interface Props<T extends Named> {
  /** お気に入り (フォルダ分けと並び順のまま) */
  nodes: FavNode<T>[];
  /** 閉じているフォルダを覚えておく場所 (お気に入りの種類ごとに分ける) */
  closedKey: string;
  /** 並び順やフォルダ分けを変えた結果を残す */
  onSaveTree: (nodes: FavNode<T>[]) => void;
  /** 選んだお気に入りをファイルへ書き出す画面を開く */
  onBackup: () => void;
  /** ファイルから取り込む画面を開く */
  onRestore: () => void;
  /** 1件も無いときの案内 */
  emptyHint: ReactNode;
  /** お気に入り1件の行 */
  renderItem: (saved: T, ctx: FavItemCtx) => ReactNode;
}

/** 放そうとしている場所 (何行目のどちら側か) */
interface Over {
  row: number;
  spot: LayoutSpot;
}

/** 掴んだと見なすまでに動かす長さ (これ未満はただの押下) */
const SLOP = 4;

export function CsvFavTree<T extends Named>({
  nodes,
  closedKey,
  onSaveTree,
  onBackup,
  onRestore,
  emptyHint,
  renderItem,
}: Props<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  /** 押さえた場所と、そこにあったもの */
  const [press, setPress] = useState<{
    x: number;
    y: number;
    drag: LayoutDrag;
  } | null>(null);
  /** 掴んでいるもの (押さえただけの間は null) */
  const [drag, setDrag] = useState<LayoutDrag | null>(null);
  /** 今どこに入れようとしているか */
  const [over, setOver] = useState<Over | null>(null);
  const overRef = useRef<Over | null>(null);
  /** 直前が「掴んで動かした」なら、続けて来る押下を効かせない */
  const moved = useRef(false);
  /** 名前を変えているフォルダ */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 閉じているフォルダ (次に開いたときのために覚えておく) */
  const [closed, setClosed] = useState(() => loadClosed(closedKey));

  /** 画面に出す行 (閉じたフォルダの中身は除く)。掴むときの当たり判定もこの並びで行う */
  const rows = useMemo(
    () => visibleRows(rowsOf(nodes), closed),
    [nodes, closed]
  );

  const putClosed = (next: Set<string>) => {
    setClosed(next);
    saveClosed(next, closedKey);
  };

  const putOver = (o: Over | null) => {
    overRef.current = o;
    setOver(o);
  };

  // 押さえている間だけ、指の動きを画面全体から拾う
  useEffect(() => {
    if (!press) return;
    let started = false;

    /** 今いる場所から、入れる所を決める (一覧の外なら決めない) */
    const aim = (x: number, y: number) => {
      const list = listRef.current;
      if (!list) return;
      const area = list.getBoundingClientRect();
      if (x < area.left || x > area.right || y < area.top || y > area.bottom) {
        putOver(null);
        return;
      }
      const boxes = [...list.querySelectorAll("[data-row]")].map((e) => {
        const b = e.getBoundingClientRect();
        return { top: b.top, height: b.height };
      });
      const hit = hitRow(boxes, y);
      if (!hit) {
        // 行より下なら、一番下 (どのフォルダにも入れない)
        putOver({ row: -1, spot: endSpot(nodes) });
        return;
      }
      const spot = spotAt(rows[hit.index], hit.upper, press.drag);
      putOver(spot ? { row: hit.index, spot } : null);
    };

    const move = (e: PointerEvent) => {
      if (!started) {
        if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < SLOP)
          return;
        started = true;
        setDrag(press.drag);
      }
      aim(e.clientX, e.clientY);
    };

    const up = () => {
      const to = overRef.current;
      if (started && to) onSaveTree(applyMove(nodes, press.drag, to.spot));
      if (started) {
        // 掴んで動かしたときは、続けて来る「押した」を捨てる
        moved.current = true;
        setTimeout(() => (moved.current = false), 0);
      }
      setPress(null);
      setDrag(null);
      putOver(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [press, nodes, rows, onSaveTree]);

  /** 行を押さえたら、掴む用意をする (動かさなければただの押下) */
  const hold = (e: React.PointerEvent, d: LayoutDrag) => {
    if (e.button !== 0 || editing) return;
    setPress({ x: e.clientX, y: e.clientY, drag: d });
  };

  /** その行に出す目印 (線か、フォルダの囲み) */
  const mark = (index: number, row: LayoutRow<T>) => {
    if (!drag || over?.row !== index) return "";
    if (row.type === "folder" && drag.type === "item") return " csv-drop-in";
    return over.spot.index <= row.at ? " csv-drop-above" : " csv-drop-below";
  };

  /** 掴んで動かした直後の「押した」は効かせない */
  const tap = (act: () => void) => () => {
    if (!moved.current) act();
  };

  /** フォルダの名前の書き換えを始める */
  const startRename = (name: string) => {
    setEditing(name);
    setDraft(name);
  };

  /** 使われていない名前で新しいフォルダを作る */
  const newFolder = () => {
    let name = "新しいフォルダ";
    for (let i = 2; usedName(nodes, name, "folder"); i += 1) {
      name = `新しいフォルダ${i}`;
    }
    onSaveTree(addFolder(nodes, name));
    startRename(name);
  };

  /** フォルダを外す (覚えていた開閉も捨てる) */
  const dropFolder = (name: string) => {
    const next = removeFolder(nodes, name);
    putClosed(pruneClosed(closed, folderNames(next)));
    onSaveTree(next);
  };

  const commitName = (from: string) => {
    const name = draft.trim();
    setEditing(null);
    if (!name || name === from) return;
    if (usedName(nodes, name, "folder")) {
      setError(`「${name}」というフォルダはすでにあります`);
      return;
    }
    setError(null);
    // 閉じていたフォルダは、名前が変わっても閉じたままにする
    putClosed(renameClosed(closed, from, name));
    onSaveTree(renameFolder(nodes, from, name));
  };

  return (
    <>
      {/*
        一覧を増やす・持ち出す操作は、一覧の項目と見分けがつくよう
        小さなボタンにして上に並べる (SQLのお気に入りと同じ並び)
      */}
      <div className="lib-saved-actions csv-fav-actions">
        <button
          className="lib-action has-tooltip tooltip-left"
          data-tooltip="フォルダを作る"
          onClick={newFolder}
        >
          ＋ フォルダ
        </button>
        <span className="toolbar-spacer" />
        <button
          className="lib-action has-tooltip"
          disabled={rows.length === 0}
          data-tooltip="選んだお気に入りをファイルへ書き出します"
          onClick={onBackup}
        >
          バックアップ…
        </button>
        <button
          className="lib-action has-tooltip"
          data-tooltip="ファイルのお気に入りを、今あるものに追加します (上書きはしません)"
          onClick={onRestore}
        >
          復元 (追加)…
        </button>
      </div>

      {error && <div className="csv-fixed-menu-error">{error}</div>}

      {rows.length === 0 ? (
        <div className="csv-empty-hint">{emptyHint}</div>
      ) : (
        <div
          className={"csv-fav-list" + (drag ? " csv-fav-dragging" : "")}
          ref={listRef}
        >
          {rows.map((row, i) =>
            row.type === "folder" ? (
              <CsvFavFolderRow
                key={`f:${row.name}`}
                name={row.name}
                count={row.count}
                open={!closed.has(row.name)}
                mark={mark(i, row)}
                draft={editing === row.name ? draft : null}
                onDraft={setDraft}
                onCommit={() => commitName(row.name)}
                onCancel={() => setEditing(null)}
                onRename={tap(() => startRename(row.name))}
                onToggle={tap(() => putClosed(toggleClosed(closed, row.name)))}
                onRemove={tap(() => dropFolder(row.name))}
                onHold={(e) => hold(e, { type: "folder", name: row.name })}
              />
            ) : (
              <Fragment key={`i:${row.saved.name}`}>
                {renderItem(row.saved, {
                  inFolder: row.folder !== null,
                  mark: mark(i, row),
                  tap,
                  hold: (e) => hold(e, { type: "item", name: row.saved.name }),
                })}
              </Fragment>
            )
          )}
          {/* 一番下へ置くための、少しだけ高さのある場所 */}
          <div
            className={
              "csv-fixed-drop-end" +
              (drag && over?.row === -1 ? " csv-drop-above" : "")
            }
          />
        </div>
      )}
    </>
  );
}
