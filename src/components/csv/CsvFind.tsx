/**
 * CSVの検索・置換バー。
 *
 * 画面は見えている行しか持っていないので、探すのはRust側に任せる。
 * 見つかった場所を親へ返し、親がそこへカーソルを動かす
 */
import { useEffect, useRef, useState } from "react";
import { csvFind, csvReplaceAll } from "../../api";
import { SelectMenu } from "../SelectMenu";
import type { CsvFindOptions, CsvInfo, CsvMatch } from "../../types";

interface Props {
  docId: string;
  /** 列を絞るときの選択肢 */
  columns: string[];
  /** 今いるセル (ここの次から探しはじめる) */
  cursor: CsvMatch | null;
  /** 見つかった場所へ移動する */
  onHit: (at: CsvMatch) => void;
  /** 置換したあとの状態 */
  onReplaced: (info: CsvInfo) => void;
  onClose: () => void;
}

export function CsvFind({
  docId,
  columns,
  cursor,
  onHit,
  onReplaced,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [column, setColumn] = useState<number | null>(null);
  const [replacing, setReplacing] = useState(false);
  /** 「3件」「見つかりません」などの知らせ */
  const [note, setNote] = useState<string | null>(null);
  const boxRef = useRef<HTMLInputElement>(null);

  useEffect(() => boxRef.current?.focus(), []);

  // 列が減ったときに、消えた列を指したままにしない
  useEffect(() => {
    if (column !== null && column >= columns.length) setColumn(null);
  }, [columns.length, column]);

  const options = (): CsvFindOptions => ({ matchCase, wholeCell, column });

  const find = async (backward: boolean) => {
    if (!query) return;
    setNote(null);
    try {
      const r = await csvFind(docId, query, options(), cursor, backward);
      if (r.hit) {
        onHit(r.hit);
        setNote(`${r.total.toLocaleString()}件`);
      } else {
        setNote("見つかりません");
      }
    } catch (e) {
      setNote(String(e));
    }
  };

  const replaceAll = async () => {
    if (!query) return;
    setReplacing(true);
    setNote(null);
    try {
      const before = await csvFind(docId, query, options(), null, false);
      const info = await csvReplaceAll(docId, query, replacement, options());
      onReplaced(info);
      setNote(`${before.total.toLocaleString()}件を置き換えました`);
    } catch (e) {
      setNote(String(e));
    } finally {
      setReplacing(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void find(e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="csv-find" onKeyDown={onKeyDown}>
      <input
        ref={boxRef}
        className="csv-find-box"
        placeholder="検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <button
        className="btn-ghost"
        title="前を検索 (Shift+Enter)"
        disabled={!query}
        onClick={() => void find(true)}
      >
        ‹
      </button>
      <button
        className="btn-ghost"
        title="次を検索 (Enter)"
        disabled={!query}
        onClick={() => void find(false)}
      >
        ›
      </button>

      <input
        className="csv-find-box"
        placeholder="置換後"
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
      />
      <button
        className="btn-secondary"
        disabled={!query || replacing}
        onClick={() => void replaceAll()}
      >
        すべて置換
      </button>

      <span className="csv-sep" />

      <label className="csv-check">
        <input
          type="checkbox"
          checked={matchCase}
          onChange={(e) => setMatchCase(e.target.checked)}
        />
        大小を区別
      </label>
      <label className="csv-check">
        <input
          type="checkbox"
          checked={wholeCell}
          onChange={(e) => setWholeCell(e.target.checked)}
        />
        セル全体
      </label>
      <div className="csv-find-col">
        <SelectMenu
          popFixed
          value={column === null ? "" : String(column)}
          options={[
            { value: "", label: "すべての列" },
            ...columns.map((c, i) => ({ value: String(i), label: c })),
          ]}
          onChange={(v) => setColumn(v === "" ? null : Number(v))}
        />
      </div>

      <span className="toolbar-spacer" />
      {note && <span className="csv-find-note">{note}</span>}
      <button className="btn-ghost" title="閉じる (Esc)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
