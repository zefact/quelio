/**
 * ツールバーの「固定長」から開くメニュー。
 *
 * 固定長のファイルは、同じ桁設定を繰り返し使う。
 * 一度お気に入りに登録しておけば、ここから選ぶだけで読み直せる
 * (桁設定のダイアログを開く必要がない)。
 *
 * 数が増えると探しにくいので、掴んで並べ替えたり、
 * フォルダを作ってまとめたりできる (フォルダは1階層まで)。
 * フォルダは行を押すと開閉し、閉じたものは次に開いたときも閉じたまま出す。
 * 行そのものは CsvFavFolderRow / CsvFavItemRow に分けてある。
 *
 * 掴む所は指の動き (pointer) で自前に作ってある。
 * このウィンドウはOSからのファイルの落とし込みを受けているので、
 * ブラウザ標準の掴み方 (draggable) を使うとそちらが先に反応してしまう。
 * 並べ方の計算は csvLayoutTree.ts に置いてある
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import type { CsvLayoutNode, CsvSavedLayout } from "../../types";
import { CsvFavFolderRow } from "./CsvFavFolderRow";
import { CsvFavItemRow } from "./CsvFavItemRow";
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
import type { LayoutDrag, LayoutRow, LayoutSpot } from "./csvLayoutTree";

interface Props {
  /**
   * 開いているタブを読み直せるか (ファイルから開いたタブのときだけ)。
   *
   * 読み直せないときも、お気に入りの整理 (並べ替え・変更・バックアップ) はできる
   */
  canApply: boolean;
  /** 今このファイルを固定長として読んでいるか */
  fixed: boolean;
  /** お気に入り (フォルダ分けと並び順のまま) */
  nodes: CsvLayoutNode[];
  /** 今このファイルに使われているお気に入りの名前 (無ければ null) */
  applied: string | null;
  /** お気に入りの桁設定で読み直す */
  onUse: (s: CsvSavedLayout) => void;
  /** お気に入りの名前・桁設定を直す画面を開く */
  onEditItem: (s: CsvSavedLayout) => void;
  /** お気に入りを削除する (確認の画面を出す。その間もこのメニューは開いたまま) */
  onDelete: (s: CsvSavedLayout) => void;
  /** 削除の確認の画面を出しているか (出している間は、その画面の後ろへ下げる) */
  confirming: boolean;
  /** 並び順やフォルダ分けを変えた結果を残す */
  onSaveTree: (nodes: CsvLayoutNode[]) => void;
  /** 桁設定のダイアログを開く */
  onEdit: () => void;
  /** 選んだお気に入りをファイルへ書き出す画面を開く */
  onBackup: () => void;
  /** ファイルから取り込む画面を開く */
  onRestore: () => void;
  /** 区切り文字として読み直す */
  onUseDelimiter: () => void;
  onClose: () => void;
}

/** 放そうとしている場所 (何行目のどちら側か) */
interface Over {
  row: number;
  spot: LayoutSpot;
}

/** 掴んだと見なすまでに動かす長さ (これ未満はただの押下) */
const SLOP = 4;

export function CsvFixedMenu({
  canApply,
  fixed,
  nodes,
  applied,
  onUse,
  onEditItem,
  onDelete,
  confirming,
  onSaveTree,
  onEdit,
  onBackup,
  onRestore,
  onUseDelimiter,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
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
  const [closed, setClosed] = useState(loadClosed);

  /** 画面に出す行 (閉じたフォルダの中身は除く)。掴むときの当たり判定もこの並びで行う */
  const rows = useMemo(
    () => visibleRows(rowsOf(nodes), closed),
    [nodes, closed]
  );

  const putClosed = (next: Set<string>) => {
    setClosed(next);
    saveClosed(next);
  };

  /*
   * メニューの外を触ったら閉じる。
   *
   * タブバーの空いている所は「窓をつかむ場所」なので、
   * ふつうの監視では押されたことが届かない。
   * 共通のフックがそこまで見てくれる
   */
  /*
   * 削除の確認の画面 (.modal-overlay) を押したときは閉じない。
   * どれを消そうとしているのかを見失わないよう、確認の間もメニューを残すため。
   * 確認中の Escape は確認の画面が先に受け取って処理済みにするので、ここまでは来ない
   */
  useDismiss(true, onClose, { ref, escape: true, inside: ".modal-overlay" });

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
  const mark = (index: number, row: LayoutRow) => {
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
    <div
      className={"csv-fixed-menu" + (confirming ? " behind" : "")}
      ref={ref}
    >
      <div className="csv-key-head csv-fav-head">お気に入り</div>

      {/*
        一覧を増やす・持ち出す操作は、一覧の項目と見分けがつくよう
        小さなボタンにして上に並べる (SQLのお気に入りと同じ並び)
      */}
      <div className="lib-saved-actions csv-fav-actions">
        <button className="lib-action" title="フォルダを作る" onClick={newFolder}>
          ＋ フォルダ
        </button>
        <span className="toolbar-spacer" />
        <button
          className="lib-action"
          disabled={rows.length === 0}
          title="選んだお気に入りをファイルへ書き出します"
          onClick={onBackup}
        >
          バックアップ
        </button>
        <button
          className="lib-action"
          title="ファイルのお気に入りを取り込みます (今あるものは上書きしません)"
          onClick={onRestore}
        >
          復元
        </button>
      </div>

      {error && <div className="csv-fixed-menu-error">{error}</div>}

      {rows.length === 0 ? (
        <div className="csv-empty-hint">
          登録されていません。桁設定のダイアログから保存できます
        </div>
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
              <CsvFavItemRow
                key={`i:${row.saved.name}`}
                saved={row.saved}
                inFolder={row.folder !== null}
                applied={applied === row.saved.name}
                canApply={canApply}
                mark={mark(i, row)}
                // 読み直す相手が無いときは、押したら直す画面を開く
                onUse={tap(() =>
                  canApply ? onUse(row.saved) : onEditItem(row.saved)
                )}
                onEdit={tap(() => onEditItem(row.saved))}
                onDelete={tap(() => onDelete(row.saved))}
                onHold={(e) => hold(e, { type: "item", name: row.saved.name })}
              />
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

      <div className="context-sep" />

      <button className="context-item" onClick={onEdit}>
        {!canApply
          ? "桁設定を新しく登録..."
          : fixed
            ? "桁設定を変更..."
            : "固定長の桁を設定..."}
      </button>
      {!canApply && (
        <div className="csv-empty-hint csv-fav-hint">
          ファイルから開いたタブでは、お気に入りを選んで読み直せます
        </div>
      )}
      {fixed && (
        <button className="context-item" onClick={onUseDelimiter}>
          区切り文字として読み直す
        </button>
      )}
    </div>
  );
}
