/**
 * CSV用の表。
 *
 * 既存の `ResizableGrid` は行を上から順に描き足していく作りで、
 * 10万行を最後までスクロールすると10万個の行がDOMに残る。
 * CSVは行数が読めないので、ここでは「見えているぶんだけ描く」形にした
 * (画面の高さから見える範囲を割り出し、その行だけを絶対配置で置く)。
 *
 * 表そのものを置き換えたわけではないので、`ResizableGrid` の挙動は変わらない
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CsvRows } from "../../hooks/useCsvRows";
import type { CsvCursor, CsvRange } from "./csvSelection";
import { frameBox, inAny, normalize } from "./csvSelection";

/** 1行の高さ (揃えておかないと、見える範囲を高さから割り出せない) */
export const ROW_H = 26;
/** 見出し行の高さ */
const HEAD_H = 30;
/** 行番号の列の幅 */
const NUM_W = 64;
/** 列の幅の下限・上限 */
const MIN_W = 60;
const MAX_W = 480;
/** 見えている範囲の外にも描いておく行数 (スクロール中の空白を減らす) */
const OVERSCAN = 8;
/** 列幅を決めるときに中身を見る行数 */
const WIDTH_SAMPLE = 50;

export type { CsvCursor, CsvRange } from "./csvSelection";

interface Props {
  columns: string[];
  rowCount: number;
  rows: CsvRows;
  /** 選んでいるセル (編集や行操作の起点にもなる) */
  cursor: CsvCursor | null;
  onCursor: (c: CsvCursor) => void;
  /** セルの中身を書き換える (編集を入れないときは省略) */
  onEdit?: (row: number, col: number, value: string) => void;
  /** 列の見出しを右クリックしたとき */
  onHeaderMenu?: (col: number, x: number, y: number) => void;
  /** 行を右クリックしたとき */
  onRowMenu?: (row: number, x: number, y: number) => void;
  /** セルに色を付ける (比較の差分表示などで使う) */
  cellClass?: (row: number, col: number) => string | undefined;
  /**
   * 続いているデータの端まで飛んだ先を訊く (Ctrl+矢印)。
   *
   * 画面に出ていない行も見るので、答えはRust側が出す
   */
  onEdge?: (from: CsvCursor, dRow: number, dCol: number) => Promise<CsvCursor>;
  /**
   * 選んでいる範囲が変わった。
   *
   * 1つだけ選んでいるときも、そのセル1つぶんの四角を1つ渡す。
   * ⌘+クリックで離れた所を足すと、四角が増える
   */
  onRange?: (rs: CsvRange[]) => void;
  /** スクロール位置を外へ伝える (分割表示の同期スクロールで使う) */
  onScrollPos?: (top: number, left: number) => void;
  /**
   * 外から指定されたスクロール位置。
   *
   * 自分が動かした側には渡さない (渡す側で undefined にする) ので、
   * ここで受け取るのは相方が動いたときだけ
   */
  syncTop?: number;
  syncLeft?: number;
}

/** 中身のだいたいの幅から列幅を決める (日本語は2文字ぶんとして数える) */
function widthOf(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    n += c > 0x1100 && c < 0xfb00 ? 2 : 1;
  }
  return n;
}

export function CsvGrid({
  columns,
  rowCount,
  rows,
  cursor,
  onCursor,
  onEdit,
  onHeaderMenu,
  onRowMenu,
  cellClass,
  onEdge,
  onRange,
  onScrollPos,
  syncTop,
  syncLeft,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  /** 編集中のセルと入力中の文字 */
  const [editing, setEditing] = useState<{ at: CsvCursor; text: string } | null>(
    null
  );
  const [widths, setWidths] = useState<number[]>([]);
  /**
   * 選んでいる範囲のもう一方の端。
   *
   * 起点は `cursor` (押した所)、`head` は伸ばした先。
   * null なら1セルだけ選んでいる
   */
  const [head, setHead] = useState<CsvCursor | null>(null);
  /**
   * ⌘+クリックで足した、離れた四角。
   *
   * 今伸ばしている四角 (cursor〜head) はここには入れず、描くときに足す
   */
  const [extra, setExtra] = useState<{ a: CsvCursor; b: CsvCursor }[]>([]);
  /** ドラッグで範囲を伸ばしている最中か */
  const dragging = useRef(false);
  /** 行番号から始めたドラッグか (行ごと選ぶ) */
  const rowDrag = useRef(false);

  /*
   * 列幅を決める。
   *
   * 見出しの長さだけで決めると、中身のほうが長い列 (メールアドレスなど) が
   * すぐ切れてしまう。とはいえ全行は見られないので、
   * 最初に届いたページの先頭だけを見て広げ、そのあとは測り直さない
   * (測り直すと、手で変えた幅を勝手に戻してしまうため)
   */
  const measured = useRef<string[] | null>(null);
  const { row: rowAt, version } = rows;
  useEffect(() => {
    if (measured.current === columns) return;
    const w = columns.map((c) => widthOf(c) * 8 + 28);
    let seen = 0;
    for (let i = 0; i < WIDTH_SAMPLE; i++) {
      const r = rowAt(i);
      if (!r) continue;
      seen++;
      for (let c = 0; c < w.length; c++) {
        w[c] = Math.max(w[c], widthOf(r[c] ?? "") * 7.5 + 24);
      }
    }
    setWidths(w.map((v) => Math.min(MAX_W, Math.max(MIN_W, Math.round(v)))));
    if (seen >= Math.min(WIDTH_SAMPLE, rowCount)) measured.current = columns;
  }, [columns, rowAt, version, rowCount]);

  // 画面の高さを測る (見える行数の計算に使う)
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visible = Math.ceil(height / ROW_H) + OVERSCAN * 2;
  const last = Math.min(rowCount, first + visible);

  // 見えている範囲を伝える (足りないページはフックが取りに行く)
  useEffect(() => {
    rows.ensure(first, last);
  }, [rows, first, last]);

  /*
   * 相方に合わせてスクロールする。
   *
   * 既にその位置なら何もしない。これを外すと、合わせた側の onScroll が
   * また相手に伝わって行ったり来たりする
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (syncTop !== undefined && Math.abs(el.scrollTop - syncTop) >= 1) {
      el.scrollTop = syncTop;
    }
    if (syncLeft !== undefined && Math.abs(el.scrollLeft - syncLeft) >= 1) {
      el.scrollLeft = syncLeft;
    }
  }, [syncTop, syncLeft]);

  /**
   * 今選んでいる四角の一式。
   *
   * ⌘+クリックで足したものが先で、最後が今伸ばしている四角
   */
  const ranges = useMemo(() => {
    const out = extra.map((e) => normalize(e.a, e.b));
    if (cursor) out.push(normalize(cursor, head ?? cursor));
    return out;
  }, [extra, cursor, head]);

  /**
   * 一番はじめに選んだセル。
   *
   * ⌘+クリックで足していっても、どこから選び始めたかが分かるようにする
   */
  const anchor = extra[0]?.a ?? cursor;

  // 選び直したら外へ知らせる (情報バーの合計などに使う)
  useEffect(() => {
    onRange?.(ranges);
  }, [ranges, onRange]);

  // 押しっぱなしを離したら、範囲を伸ばすのをやめる
  useEffect(() => {
    const up = () => {
      dragging.current = false;
      rowDrag.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  /** 指定のセルが見えるところまでスクロールする */
  const reveal = useCallback((row: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const top = row * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_H - el.clientHeight;
    }
  }, []);

  /**
   * カーソルを動かす。
   *
   * `extend` (Shiftを押しながら) のときは起点を残したまま端だけを伸ばす
   */
  const move = (dr: number, dc: number, extend = false) => {
    if (!cursor) return;
    const from = extend ? (head ?? cursor) : cursor;
    const row = Math.min(rowCount - 1, Math.max(0, from.row + dr));
    const col = Math.min(columns.length - 1, Math.max(0, from.col + dc));
    if (extend) setHead({ row, col });
    else {
      setExtra([]);
      setHead(null);
      onCursor({ row, col });
    }
    reveal(row);
  };

  /** 編集を始める (initial を渡すとその文字から始める) */
  const startEdit = (at: CsvCursor, initial?: string) => {
    if (!onEdit) return;
    const cur = rows.row(at.row)?.[at.col] ?? "";
    setEditing({ at, text: initial ?? cur });
  };

  const commit = (move: "down" | "right" | "none") => {
    if (!editing || !onEdit) return;
    onEdit(editing.at.row, editing.at.col, editing.text);
    setEditing(null);
    if (move === "down" && editing.at.row + 1 < rowCount) {
      onCursor({ row: editing.at.row + 1, col: editing.at.col });
      reveal(editing.at.row + 1);
    } else if (move === "right" && editing.at.col + 1 < columns.length) {
      onCursor({ row: editing.at.row, col: editing.at.col + 1 });
    }
  };

  /** 端 (先頭・末尾) まで一気に飛ぶ (⌘+矢印) */
  const jumpEnd = (dr: number, dc: number, extend: boolean) => {
    if (!cursor) return;
    const from = extend ? (head ?? cursor) : cursor;
    const to = {
      row: dr > 0 ? Math.max(0, rowCount - 1) : dr < 0 ? 0 : from.row,
      col: dc > 0 ? Math.max(0, columns.length - 1) : dc < 0 ? 0 : from.col,
    };
    if (extend) setHead(to);
    else {
      setExtra([]);
      setHead(null);
      onCursor(to);
    }
    reveal(to.row);
  };

  /** 続いているデータの端まで飛ぶ (Ctrl+矢印) */
  const jumpEdge = async (dr: number, dc: number, extend: boolean) => {
    if (!cursor || !onEdge) return;
    const from = extend ? (head ?? cursor) : cursor;
    try {
      const to = await onEdge(from, dr, dc);
      if (extend) setHead(to);
      else {
        setExtra([]);
        setHead(null);
        onCursor(to);
      }
      reveal(to.row);
    } catch {
      /* 答えが取れなければ動かさない */
    }
  };

  /** 矢印キーと進む向き */
  const ARROWS: Record<string, [number, number]> = {
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0],
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    if (!cursor) return;
    /*
     * ⌘+矢印はその列 (行) の端まで、Ctrl+矢印は続いているデータの端まで。
     * 表計算ソフトと同じ動きにしてある
     */
    const dir = ARROWS[e.key];
    if (dir) {
      if (e.metaKey) {
        e.preventDefault();
        jumpEnd(dir[0], dir[1], e.shiftKey);
        return;
      }
      if (e.ctrlKey) {
        e.preventDefault();
        void jumpEdge(dir[0], dir[1], e.shiftKey);
        return;
      }
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1, 0, e.shiftKey);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1, 0, e.shiftKey);
        return;
      case "ArrowRight":
        e.preventDefault();
        move(0, 1, e.shiftKey);
        return;
      case "ArrowLeft":
        e.preventDefault();
        move(0, -1, e.shiftKey);
        return;
      case "Tab":
        e.preventDefault();
        move(0, e.shiftKey ? -1 : 1);
        return;
      case "PageDown":
        e.preventDefault();
        move(Math.floor(height / ROW_H), 0, e.shiftKey);
        return;
      case "PageUp":
        e.preventDefault();
        move(-Math.floor(height / ROW_H), 0, e.shiftKey);
        return;
      case "Enter":
      case "F2":
        e.preventDefault();
        startEdit(cursor);
        return;
    }
    /*
     * 文字を打ったらそのまま編集を始める。
     *
     * 日本語入力 (変換中) はここでは拾わない。
     * keydownの時点ではまだ文字が確定しておらず、拾うと最初の1文字が消える。
     * 日本語を打つときは Enter か F2 で編集を始めてもらう
     */
    if (
      onEdit &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing &&
      e.key.length === 1
    ) {
      e.preventDefault();
      startEdit(cursor, e.key);
    }
  };

  const total = useMemo(
    () => widths.reduce((a, b) => a + b, NUM_W),
    [widths]
  );

  /** 列の左端の位置 (絶対配置に使う) */
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = NUM_W;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return out;
  }, [widths]);

  const items = [];
  for (let i = first; i < last; i++) {
    const cells = rows.row(i);
    items.push(
      <div
        key={i}
        className={"csv-row" + (cursor?.row === i ? " current" : "")}
        style={{ top: i * ROW_H, width: total }}
        onContextMenu={(e) => {
          if (!onRowMenu) return;
          e.preventDefault();
          onRowMenu(i, e.clientX, e.clientY);
        }}
      >
        <div
          className={
            "csv-num" +
            (ranges.some((r) => i >= r.top && i <= r.bottom) ? " on" : "")
          }
          style={{ width: NUM_W }}
          title="押すとこの行を選びます"
          onMouseDown={(e) => {
            e.preventDefault();
            const end = { row: i, col: Math.max(0, columns.length - 1) };
            if (e.shiftKey && cursor) {
              setHead(end);
              return;
            }
            // ⌘ を押しながらなら、今までの選択に足す
            if ((e.metaKey || e.ctrlKey) && cursor) {
              setExtra((prev) => [...prev, { a: cursor, b: head ?? cursor }]);
            } else {
              setExtra([]);
            }
            dragging.current = true;
            rowDrag.current = true;
            onCursor({ row: i, col: 0 });
            setHead(end);
          }}
          onMouseEnter={() => {
            if (dragging.current && rowDrag.current) {
              setHead({ row: i, col: Math.max(0, columns.length - 1) });
            }
          }}
        >
          {i + 1}
        </div>
        {columns.map((_, c) => (
          <div
            key={c}
            className={
              "csv-cell" +
              // 一番はじめに選んだセル (どこから選び始めたかの印)
              (anchor?.row === i && anchor?.col === c ? " selected" : "") +
              // 選んでいるセル (はじめの1つもここに入る)
              (inAny(ranges, i, c) ? " in-range" : "") +
              (cellClass?.(i, c) ? ` ${cellClass(i, c)}` : "")
            }
            style={{ left: lefts[c], width: widths[c] }}
            onMouseDown={(e) => {
              if (e.shiftKey && cursor) {
                e.preventDefault();
                setHead({ row: i, col: c });
                return;
              }
              /*
               * ⌘ (Windowsでは Ctrl) を押しながらなら、
               * 今までの選択を残したまま、離れた所を足す
               */
              if ((e.metaKey || e.ctrlKey) && cursor) {
                e.preventDefault();
                setExtra((prev) => [...prev, { a: cursor, b: head ?? cursor }]);
              } else {
                setExtra([]);
              }
              dragging.current = true;
              rowDrag.current = false;
              setHead(null);
              onCursor({ row: i, col: c });
            }}
            onMouseEnter={() => {
              if (dragging.current && !rowDrag.current) setHead({ row: i, col: c });
            }}
            onDoubleClick={() => startEdit({ row: i, col: c })}
            title={cells?.[c]}
          >
            {cells === null ? "" : (cells[c] ?? "")}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="csv-grid"
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop);
        onScrollPos?.(e.currentTarget.scrollTop, e.currentTarget.scrollLeft);
      }}
    >
      <div className="csv-head" style={{ width: total, height: HEAD_H }}>
        <div className="csv-num head" style={{ width: NUM_W }}>
          #
        </div>
        {columns.map((name, c) => (
          <div
            key={c}
            className="csv-col"
            style={{ left: lefts[c], width: widths[c] }}
            title={name}
            onContextMenu={(e) => {
              if (!onHeaderMenu) return;
              e.preventDefault();
              onHeaderMenu(c, e.clientX, e.clientY);
            }}
          >
            <span className="csv-col-name">{name}</span>
            <span
              className="csv-col-grip"
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = widths[c];
                const onMove = (m: MouseEvent) => {
                  const w = Math.min(
                    MAX_W,
                    Math.max(MIN_W, startW + m.clientX - startX)
                  );
                  setWidths((prev) =>
                    prev.map((v, i) => (i === c ? w : v))
                  );
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            />
          </div>
        ))}
      </div>

      {/* スクロールの高さを作るための場所取り (中身は絶対配置で置く) */}
      <div
        className="csv-body"
        style={{ height: rowCount * ROW_H, width: total }}
      >
        {/*
          選んでいる範囲を紫の枠で囲む。
          セルに縁を付けると文字がずれるので、上に重ねた枠で描く
        */}
        {ranges.map((r, i) => {
          const box = frameBox(r, lefts, widths, ROW_H, NUM_W);
          return <div key={i} className="csv-sel-frame" style={box} />;
        })}
        {items}
        {editing && (
          <input
            className="csv-editor mono"
            autoFocus
            value={editing.text}
            style={{
              top: editing.at.row * ROW_H,
              left: lefts[editing.at.col],
              width: widths[editing.at.col],
              height: ROW_H,
            }}
            onChange={(e) =>
              setEditing({ at: editing.at, text: e.target.value })
            }
            onKeyDown={(e) => {
              // 変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                commit("down");
              } else if (e.key === "Tab") {
                e.preventDefault();
                commit("right");
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(null);
              }
            }}
            onBlur={() => commit("none")}
          />
        )}
      </div>
    </div>
  );
}
