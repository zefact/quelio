/**
 * ツールバーの「固定長」から開くメニュー。
 *
 * 固定長のファイルは、同じ桁設定を繰り返し使う。
 * 一度お気に入りに登録しておけば、ここから選ぶだけで読み直せる
 * (桁設定のダイアログを開く必要がない)。
 *
 * 数が増えると探しにくいので、掴んで並べ替えたり、
 * フォルダを作ってまとめたりできる (フォルダは1階層まで)。
 *
 * 掴む所は指の動き (pointer) で自前に作ってある。
 * このウィンドウはOSからのファイルの落とし込みを受けているので、
 * ブラウザ標準の掴み方 (draggable) を使うとそちらが先に反応してしまう。
 * 並べ方の計算は csvLayoutTree.ts に置いてある
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import type { CsvLayoutNode, CsvSavedLayout } from "../../types";
import { CloseMark } from "../CloseMark";
import { UNIT_LABEL, totalWidth } from "./csvFixed";
import {
  addFolder,
  applyMove,
  endSpot,
  hitRow,
  removeFolder,
  renameFolder,
  rowsOf,
  spotAt,
  usedName,
} from "./csvLayoutTree";
import type { LayoutDrag, LayoutRow, LayoutSpot } from "./csvLayoutTree";

interface Props {
  /** 今このファイルを固定長として読んでいるか */
  fixed: boolean;
  /** お気に入り (フォルダ分けと並び順のまま) */
  nodes: CsvLayoutNode[];
  /** 今このファイルに使われているお気に入りの名前 (無ければ null) */
  applied: string | null;
  /** お気に入りの桁設定で読み直す */
  onUse: (s: CsvSavedLayout) => void;
  /** お気に入りを削除する */
  onDelete: (s: CsvSavedLayout) => void;
  /** 並び順やフォルダ分けを変えた結果を残す */
  onSaveTree: (nodes: CsvLayoutNode[]) => void;
  /** 桁設定のダイアログを開く */
  onEdit: () => void;
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
  fixed,
  nodes,
  applied,
  onUse,
  onDelete,
  onSaveTree,
  onEdit,
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

  const rows = useMemo(() => rowsOf(nodes), [nodes]);

  /*
   * メニューの外を触ったら閉じる。
   *
   * タブバーの空いている所は「窓をつかむ場所」なので、
   * ふつうの監視では押されたことが届かない。
   * 共通のフックがそこまで見てくれる
   */
  useDismiss(true, onClose, { ref, escape: true });

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

  /** 使われていない名前で新しいフォルダを作る */
  const newFolder = () => {
    let name = "新しいフォルダ";
    for (let i = 2; usedName(nodes, name, "folder"); i += 1) {
      name = `新しいフォルダ${i}`;
    }
    onSaveTree(addFolder(nodes, name));
    setEditing(name);
    setDraft(name);
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
    onSaveTree(renameFolder(nodes, from, name));
  };

  return (
    <div className="csv-fixed-menu" ref={ref}>
      <div className="csv-key-head csv-fav-head">
        <span>お気に入り</span>
        <button
          className="btn-ghost csv-fav-addfolder"
          title="フォルダを作る"
          onClick={newFolder}
        >
          ＋ フォルダ
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
              <div
                className={"csv-fixed-folder" + mark(i, row)}
                key={`f:${row.name}`}
                data-row=""
                onPointerDown={(e) =>
                  hold(e, { type: "folder", name: row.name })
                }
              >
                <span className="csv-fixed-folder-icon" aria-hidden>
                  <FolderIcon />
                </span>
                {editing === row.name ? (
                  <input
                    className="csv-fixed-folder-input"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitName(row.name)}
                    onKeyDown={(e) => {
                      // ここで止めないと、同じEscapeでメニューまで閉じてしまう
                      if (e.key === "Enter" || e.key === "Escape") {
                        e.preventDefault();
                      }
                      if (e.key === "Enter") commitName(row.name);
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span
                    className="csv-fixed-folder-name"
                    title="ドラッグで移動 / ダブルクリックで名前を変更"
                    onDoubleClick={() => {
                      setEditing(row.name);
                      setDraft(row.name);
                    }}
                  >
                    {row.name}
                  </span>
                )}
                <span className="csv-fixed-menu-note mono">{row.count}</span>
                <button
                  className="btn-ghost csv-fav-act"
                  title="フォルダ名を変更"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    if (moved.current) return;
                    setEditing(row.name);
                    setDraft(row.name);
                  }}
                >
                  <RenameIcon />
                </button>
                <button
                  className="btn-ghost csv-fixed-del"
                  title="フォルダを外す (中のお気に入りは残ります)"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onSaveTree(removeFolder(nodes, row.name))}
                >
                  <CloseMark size={10} />
                </button>
              </div>
            ) : (
              <div
                className={
                  "csv-fixed-menu-row" +
                  (row.folder ? " csv-fixed-inside" : "") +
                  mark(i, row)
                }
                key={`i:${row.saved.name}`}
                data-row=""
                onPointerDown={(e) =>
                  hold(e, { type: "item", name: row.saved.name })
                }
              >
                <button
                  className={
                    "context-item" +
                    (applied === row.saved.name ? " csv-fixed-applied" : "")
                  }
                  title={
                    (applied === row.saved.name
                      ? "このファイルに使われています\n"
                      : "") +
                    `${row.saved.layout.columns.length}桁 (計${totalWidth(
                      row.saved.layout.columns
                    )}${UNIT_LABEL[row.saved.layout.unit]})\nドラッグで移動`
                  }
                  onClick={() => !moved.current && onUse(row.saved)}
                >
                  {/* 幅を取っておくと、印の有無で名前の頭が動かない */}
                  <span className="csv-fixed-menu-check" aria-hidden>
                    {applied === row.saved.name ? "✓" : ""}
                  </span>
                  <span className="csv-fixed-menu-name">{row.saved.name}</span>
                  <span className="csv-fixed-menu-note mono">
                    {row.saved.layout.columns.length}桁
                  </span>
                </button>
                <button
                  className="btn-ghost csv-fixed-del"
                  title="このお気に入りを削除"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => !moved.current && onDelete(row.saved)}
                >
                  <CloseMark size={10} />
                </button>
              </div>
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
        {fixed ? "桁設定を変更..." : "固定長の桁を設定..."}
      </button>
      {fixed && (
        <button className="context-item" onClick={onUseDelimiter}>
          区切り文字として読み直す
        </button>
      )}
    </div>
  );
}

/** 名前を変える絵 (鉛筆) */
function RenameIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** フォルダの絵 */
function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
