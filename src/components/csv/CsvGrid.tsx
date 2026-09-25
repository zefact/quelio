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
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CsvRows } from "../../hooks/useCsvRows";
import { insertNewline, lineCount, lineParts } from "./csvCellEdit";
import { markSegments } from "./csvMark";
import { edgeGap } from "./csvScrollbar";
import { MAX_W, MIN_W, fitWidth } from "./csvWidth";
import type { CsvBlock, CsvCursor, CsvRange } from "./csvSelection";
import {
  colBlock,
  colInAny,
  clipRange,
  frameBox,
  inAny,
  jumpFix,
  normalize,
  rowBlock,
  rowInAny,
} from "./csvSelection";
import { imeBusy } from "../../ime";
import { loadCsvScroll, saveCsvScroll } from "./csvScrollMemo";

/** 1行の高さ (揃えておかないと、見える範囲を高さから割り出せない) */
export const ROW_H = 26;
/** 見出し行の高さ */
export const HEAD_H = 30;
/** 行番号の列の幅 */
const NUM_W = 64;
/** 見えている範囲の外にも描いておく行数 (スクロール中の空白を減らす) */
const OVERSCAN = 8;

/** 開いたときに列幅を決めるために中身を見る行数 */
const WIDTH_SAMPLE = 50;

/** セルの入力欄を伸ばす上限 (行数) */
const EDIT_MAX_LINES = 6;

/** 幅を中身に合わせるとき (仕切りのダブルクリック) に見る行数 */
const FIT_SAMPLE = 300;

export type { CsvCursor, CsvRange } from "./csvSelection";

interface Props {
  columns: string[];
  rowCount: number;
  rows: CsvRows;
  /** 選んでいるセル (編集や行操作の起点にもなる) */
  cursor: CsvCursor | null;
  /** カーソルを動かす (行・列が1つも無くなったときは null) */
  onCursor: (c: CsvCursor | null) => void;
  /**
   * 外からカーソルを動かされたとき、選んでいる範囲を残すか。
   *
   * 「選んだ範囲の中だけを探す」で次へ進むときに使う。
   * 残さないときは、動いた先の1セルだけを選んだ状態にする
   */
  keepRange?: boolean;
  /** セルの中身を書き換える (編集を入れないときは省略) */
  onEdit?: (row: number, col: number, value: string) => void;
  /**
   * セルの中で改行できるか (Option/Alt + Enter)。
   *
   * 引用符で囲まない形式や固定長では、改行を入れるとファイルが壊れるので
   * 呼び出し側が false を渡す
   */
  canNewline?: boolean;
  /** 改行できない形式で入れようとしたとき (理由を出すのに使う) */
  onDenyNewline?: () => void;
  /**
   * 列の見出しを右クリックしたとき。
   *
   * `block` は押した所と地続きで選ばれている列のかたまり
   * (「まとめて追加・削除」を出すのに使う)
   */
  onHeaderMenu?: (col: number, x: number, y: number, block: CsvBlock) => void;
  /** 行を右クリックしたとき (`block` の意味は onHeaderMenu と同じ) */
  onRowMenu?: (row: number, x: number, y: number, block: CsvBlock) => void;
  /** セルに色を付ける (比較の差分表示などで使う) */
  cellClass?: (row: number, col: number) => string | undefined;
  /**
   * 行番号として出す数 (省略すると画面の位置そのまま)。
   *
   * 絞り込んでいるときに、元のファイルの行番号を出すために使う
   */
  rowNumber?: (row: number) => number;
  /** 見出しに絞り込みのつまみを出すか */
  showFilter?: boolean;
  /** その列に絞り込みが掛かっているか (つまみの色を変える) */
  isFiltered?: (col: number) => boolean;
  /**
   * 絞り込みのつまみを押した。
   *
   * つまみの左下 (x, y) と上端 (flipY) を渡す。
   * 画面の下で切れるときに、上へ折り返して出せるようにする
   */
  onFilter?: (col: number, x: number, y: number, flipY: number) => void;
  /** 絞り込みのつまみに出す吹き出し */
  filterTip?: (col: number) => string;
  /** その列の並べ替え (していなければ何も返さない) */
  sortMark?: (col: number) => "asc" | "desc" | undefined;
  /**
   * 列の名前を変える (見出しのダブルクリックで書き換えたとき)。
   *
   * 渡さなければ、見出しは書き換えられない
   */
  onRename?: (col: number, name: string) => void;
  /** 行に色を付ける (種別が混ざったファイルのヘッダ行などで使う) */
  rowClass?: (row: number) => string | undefined;
  /**
   * 探している語 (検索中だけ渡す)。
   *
   * 見えているセルの中で、この語に当たる所を目立たせる
   */
  findQuery?: string;
  /** 探すときに英字の大小を区別するか */
  findCase?: boolean;
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
  /**
   * 選んでいる範囲をコピーする (⌘/Ctrl+C)。
   *
   * 画面に出ていない行も選べるので、文字を組み立てるのは受け取った側の仕事。
   * 今の範囲をそのまま渡すので、分割表示でもどちらの表かを取り違えない
   */
  onCopy?: (rs: CsvRange[]) => void;
  /**
   * クリップボードの中身を貼り付ける (⌘/Ctrl+V)。
   *
   * カーソルと、今選んでいる範囲を渡す。中身の読み取りは受け取った側の仕事。
   * 値1つを範囲へ貼るときは範囲を全部埋めるので、範囲も一緒に要る
   */
  onPaste?: (at: CsvCursor, ranges: CsvRange[]) => void;
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
  /**
   * 開いた直後に、この表へキー操作を向けるか。
   *
   * 触っている側の表にだけ渡す (左右に分けているとき、
   * 両方が取り合うと後から描いたほうへ行ってしまう)
   */
  autoFocus?: boolean;
  /**
   * スクロール位置を控えておく名前 (面とファイルごと)。
   * タブを切り替えて表を作り直したとき、同じ名前の控えから元の位置へ戻す
   */
  memoKey?: string;
}

export function CsvGrid({
  columns,
  rowCount,
  rows,
  cursor,
  onCursor,
  keepRange,
  onEdit,
  canNewline = true,
  onDenyNewline,
  onHeaderMenu,
  onRowMenu,
  cellClass,
  rowNumber,
  showFilter,
  isFiltered,
  onFilter,
  filterTip,
  sortMark,
  onRename,
  rowClass,
  findQuery,
  findCase,
  onEdge,
  onRange,
  onCopy,
  onPaste,
  onScrollPos,
  syncTop,
  syncLeft,
  autoFocus,
  memoKey,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 前にこの表を開いていたときのスクロール位置 (作り直したときに戻す) */
  const [restored] = useState(() =>
    memoKey ? loadCsvScroll(memoKey) : undefined
  );
  const [scrollTop, setScrollTop] = useState(restored?.top ?? 0);
  /**
   * 元の位置へ戻したときのカーソル。
   * カーソルが動くまでは、カーソルの所まで表を動かさない
   * (列幅が決まるなどで下の効果が走り直しても、見ていた所に留める)。
   * カーソルから離れた所を見ていたなら、その見ていた所へ戻したいため
   */
  const keepView = useRef(restored ? cursor : null);
  /**
   * まだ戻せていない横の位置。
   * 列幅は行が届いてから中身へ合わせて決まるので、最初は表が狭く
   * 横の位置が端で切られてしまう。表が広がるたびに合わせ直し、
   * 届いたら (または自分で動かしたら) やめる
   */
  const pendingLeft = useRef(restored ? restored.left : null);
  const [height, setHeight] = useState(600);
  /** 編集中のセルと入力中の文字 */
  const [editing, setEditing] = useState<{ at: CsvCursor; text: string } | null>(
    null
  );
  /** 入力欄 (改行を入れたあとに印の位置を戻すのに使う) */
  const editRef = useRef<HTMLTextAreaElement>(null);
  /** 次の描画で当てる印の位置 (要らないときは null) */
  const caret = useRef<number | null>(null);
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
  /**
   * 自分で動かしたカーソル。
   *
   * 外から動かされたのかを見分けるために覚えておく
   * (親に渡したものがそのまま戻ってくれば、自分で動かしたということ)
   */
  const sent = useRef<CsvCursor | null>(null);
  /** 今カーソルがある所 (動く前がどこだったかを知るために覚えておく) */
  const shown = useRef<CsvCursor | null>(null);
  /**
   * 検索でカーソルだけが範囲の中を動いている最中か。
   *
   * このあいだは選んだ範囲を動かさず、カーソルだけが中を移る。
   * 「はじめに選んだセル」の印もカーソルに付ける
   */
  const [roam, setRoam] = useState(false);
  /** ドラッグで範囲を伸ばしている最中か */
  const dragging = useRef(false);
  /** 書き換えている列の見出し (していなければ null) */
  const [editHead, setEditHead] = useState<{ col: number; text: string } | null>(
    null
  );
  /** 行番号から始めたドラッグか (行ごと選ぶ) */
  const rowDrag = useRef(false);
  /** 見出しから始めたドラッグか (列ごと選ぶ) */
  const colDrag = useRef(false);

  /** 見出しの書き換えを確かめる (変わっていなければ何もしない) */
  const commitHead = () => {
    if (!editHead) return;
    const { col, text } = editHead;
    setEditHead(null);
    if (text !== (columns[col] ?? "")) onRename?.(col, text);
  };

  /** カーソルを動かす (自分で動かしたことを覚えてから伝える) */
  const putCursor = (c: CsvCursor) => {
    sent.current = c;
    setRoam(false);
    onCursor(c);
  };

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
    // 先頭のほうの行を見て、見出しと中身が収まる幅にする
    const sample: string[][] = [];
    for (let i = 0; i < WIDTH_SAMPLE; i++) {
      const r = rowAt(i);
      if (r) sample.push(r);
    }
    setWidths(
      columns.map((name, c) => fitWidth(name, sample.map((r) => r[c] ?? "")))
    );
    if (sample.length >= Math.min(WIDTH_SAMPLE, rowCount)) {
      measured.current = columns;
    }
  }, [columns, rowAt, version, rowCount]);

  /*
   * 開いた直後にキー操作を受け取れるようにする。
   *
   * 印は最初から1行1列目に出ているのに、表に入力が向いていないと
   * 打った文字がどこにも入らず「効かない」ように見える。
   * ファイルを開いた・タブを切り替えたときはここから作り直されるので、
   * その1回だけ向け直す
   */
  useEffect(() => {
    if (autoFocus) wrapRef.current?.focus();
    // 開いたときの1回だけ (以後はクリックで移る)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 前に見ていた位置へ戻す (描く行も合わせるので、最初の描画の直後に行う)
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || !restored) return;
    el.scrollTop = restored.top;
    el.scrollLeft = restored.left;
    // 行が足りずに端で切られたときは、実際の位置に合わせる
    setScrollTop(el.scrollTop);
    if (Math.abs(el.scrollLeft - restored.left) < 1) pendingLeft.current = null;
    // 開いたときの1回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 行や列が減ったら (末尾の行を消したなど)、カーソルと選んでいる範囲を今ある所へ寄せる。
   * そのままだと、カーソルが消した行を指したまま表のどこにも出ず、
   * 情報バーの選択も消した行を数えてしまう
   */
  const prevRowCount = useRef(rowCount);
  useEffect(() => {
    const before = prevRowCount.current;
    prevRowCount.current = rowCount;
    if (rowCount === 0 || columns.length === 0) {
      // 全部消えたら、カーソルも選択も無くす (どこも指せない)
      if (head) setHead(null);
      setExtra((prev) => (prev.length === 0 ? prev : []));
      if (cursor) onCursor(null);
      return;
    }
    // 空の表に行が入ったら、先頭にカーソルを置き直す (キー操作ですぐ動けるように)
    if (!cursor && before === 0) {
      onCursor({ row: 0, col: 0 });
      return;
    }
    const maxRow = rowCount - 1;
    const maxCol = columns.length - 1;
    const outside = (c: CsvCursor) => c.row > maxRow || c.col > maxCol;
    const fit = (c: CsvCursor): CsvCursor => ({
      row: Math.min(c.row, maxRow),
      col: Math.min(c.col, maxCol),
    });
    if (head && outside(head)) setHead(fit(head));
    setExtra((prev) => {
      // 丸ごと消えた範囲は外し、はみ出しているものは端までに縮める
      const next = prev
        .filter(
          (e) =>
            Math.min(e.a.row, e.b.row) <= maxRow &&
            Math.min(e.a.col, e.b.col) <= maxCol
        )
        .map((e) => ({ a: fit(e.a), b: fit(e.b) }));
      const same =
        next.length === prev.length &&
        next.every(
          (e, i) =>
            e.a.row === prev[i].a.row &&
            e.a.col === prev[i].a.col &&
            e.b.row === prev[i].b.row &&
            e.b.col === prev[i].b.col
        );
      return same ? prev : next;
    });
    // カーソルは最後に動かす (見えるところまで表が動く)
    if (cursor && outside(cursor)) onCursor(fit(cursor));
    // 行数・列数が変わったときだけ見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowCount, columns.length]);

  /*
   * 行が減ったら (末尾の行を消したなど)、ブラウザが縮めたスクロール位置に合わせる。
   * 縮めたときにスクロールの知らせが来ない環境があり、そのままだと
   * 前の位置のつもりで描いて、何も無い所を見せてしまう
   */
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - scrollTop) >= 1) setScrollTop(el.scrollTop);
    // 行数が変わったときだけ見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowCount]);

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
   * 改行を入れたあと、印を入れた場所へ戻す。
   *
   * 中身を差し替えると印は末尾へ飛ぶので、描いたあとに置き直す
   */
  useEffect(() => {
    if (caret.current === null) return;
    editRef.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

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
    // 検索でカーソルだけが動いている最中は、選んだ範囲はそのままにする
    if (cursor && !roam) out.push(normalize(cursor, head ?? cursor));
    return out;
  }, [extra, cursor, head, roam]);

  /**
   * 一番はじめに選んだセル。
   *
   * ⌘+クリックで足していっても、どこから選び始めたかが分かるようにする
   */
  const anchor = roam ? cursor : (extra[0]?.a ?? cursor);

  // 選び直したら外へ知らせる (情報バーの合計などに使う)
  useEffect(() => {
    onRange?.(ranges);
  }, [ranges, onRange]);

  // 押しっぱなしを離したら、範囲を伸ばすのをやめる
  useEffect(() => {
    const up = () => {
      dragging.current = false;
      rowDrag.current = false;
      colDrag.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  /** 指定のセルが見えるところまでスクロールする */
  /**
   * 指定の行が見えるところまで縦に動かす。
   *
   * 見出しの行は上に貼り付いたままなので、その厚みぶんは隠れている。
   * 下端はスクロールバーが重なる環境があるので、そのぶんも見込む
   */
  const reveal = useCallback((row: number) => {
    const el = wrapRef.current;
    if (!el) return;
    // 中身の中での行の位置 (見出しの行のぶんだけ下にある)
    const top = HEAD_H + row * ROW_H;
    // 見出しに隠れないぎりぎり / スクロールバーに隠れないぎりぎり
    const upTo = top - HEAD_H;
    const from = top + ROW_H + edgeGap() - el.clientHeight;
    if (el.scrollTop > upTo) el.scrollTop = upTo;
    else if (el.scrollTop < from) el.scrollTop = from;
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
      putCursor({ row, col });
    }
    reveal(row);
  };

  /** 編集を始める (initial を渡すとその文字から始める) */
  const startEdit = (at: CsvCursor, initial?: string) => {
    if (!onEdit) return;
    const cur = rows.row(at.row)?.[at.col] ?? "";
    setEditing({ at, text: initial ?? cur });
  };

  const commit = (move: "down" | "up" | "right" | "none") => {
    if (!editing || !onEdit) return;
    onEdit(editing.at.row, editing.at.col, editing.text);
    setEditing(null);
    /*
     * 入力欄が消えると印がどこにも無くなり、矢印キーが表に届かなくなる。
     * 表へ戻しておく
     */
    wrapRef.current?.focus();
    if (move === "down" && editing.at.row + 1 < rowCount) {
      putCursor({ row: editing.at.row + 1, col: editing.at.col });
      reveal(editing.at.row + 1);
    } else if (move === "up" && editing.at.row > 0) {
      putCursor({ row: editing.at.row - 1, col: editing.at.col });
      reveal(editing.at.row - 1);
    } else if (move === "right" && editing.at.col + 1 < columns.length) {
      putCursor({ row: editing.at.row, col: editing.at.col + 1 });
    }
  };

  /** 表全体を選ぶ (左上の「#」と ⌘/Ctrl+A) */
  const selectAll = () => {
    if (rowCount === 0 || columns.length === 0) return;
    wrapRef.current?.focus();
    setExtra([]);
    putCursor({ row: 0, col: 0 });
    setHead({ row: rowCount - 1, col: columns.length - 1 });
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
      putCursor(to);
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
        putCursor(to);
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
    // ⌘/Ctrl+A は表全体を選ぶ (まだどこも選んでいなくても効く)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll();
      return;
    }
    if (!cursor) return;
    /*
     * ⌘/Ctrl+C で、選んでいる範囲をタブ区切りでコピーする。
     *
     * セルの中の文字を選んでいるときは、ふつうのコピーに任せる
     * (値の一部だけを取りたいことがあるため)
     */
    if (onCopy && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      e.preventDefault();
      onCopy(ranges);
      return;
    }
    // ⌘/Ctrl+V は、選んでいる範囲へ貼り付ける
    if (onPaste && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      onPaste(cursor, ranges);
      return;
    }
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
        // 編集していないときの Shift+Enter は、上のセルへ動くだけ
        if (e.key === "Enter" && e.shiftKey) {
          move(-1, 0);
          return;
        }
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
      !imeBusy(e) &&
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

  // 表が広がったら、戻しきれていなかった横の位置へ合わせ直す
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const want = pendingLeft.current;
    if (!el || want === null) return;
    el.scrollLeft = want;
    if (Math.abs(el.scrollLeft - want) < 1) pendingLeft.current = null;
  }, [total]);

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

  /** 指定の列が見えるところまで横に動かす */
  const revealCol = useCallback(
    (col: number) => {
      const el = wrapRef.current;
      const left = lefts[col];
      const w = widths[col];
      if (!el || left === undefined || w === undefined) return;
      // 行番号の列は左に貼り付いたままなので、その幅ぶんは隠れている
      if (left - NUM_W < el.scrollLeft) {
        el.scrollLeft = Math.max(0, left - NUM_W);
      } else if (left + w + edgeGap() > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = left + w + edgeGap() - el.clientWidth;
      }
    },
    [lefts, widths]
  );

  /*
   * 外からカーソルが動いたら (検索で見つかった所へ飛ぶなど)、
   * そのセルが見えるところまでスクロールし、選んでいた範囲を畳む。
   *
   * 畳まないと、伸ばしていた端 (head) だけが取り残されて、
   * 動く前の所と動いた先の間が選ばれた妙な四角になってしまう。
   * `keepRange` のときは、それまでの範囲をその場に固定して、
   * カーソルだけが範囲の中を動くようにする
   */
  useEffect(() => {
    if (!cursor) return;
    /*
     * カーソルは動いていない (列幅を変えたなどで、見せ方の関数が作り直されただけ)。
     * ここで動かすと、離れた列の幅を変えただけでカーソルの所へ戻されてしまう
     */
    if (shown.current === cursor) return;
    const kept = keepView.current;
    if (kept && kept.row === cursor.row && kept.col === cursor.col) {
      // 元の位置へ戻したところなので、カーソルの所へは動かさない
      shown.current = cursor;
      return;
    }
    keepView.current = null;
    const own =
      sent.current?.row === cursor.row && sent.current?.col === cursor.col;
    /*
     * 縦は、自分で動かしたときは動かさない。
     * 見出しを押して列ごと選ぶと印は1行目へ行くが、
     * そこまで表が飛ぶと、見ていた所を見失うため
     */
    if (!own) reveal(cursor.row);
    revealCol(cursor.col);
    // 動く前にいた所 (伸ばしかけの四角の起点)
    const from = shown.current;
    shown.current = cursor;
    if (own) return;
    setRoam(!!keepRange);
    const fix = jumpFix(!!keepRange, from, head);
    if (fix === "clear") setExtra([]);
    // 伸ばしかけだった四角は、カーソルが動く前の形のまま残す
    else if (fix) setExtra((prev) => [...prev, fix]);
    setHead(null);
    // 選び方の後始末は、カーソルが動いたときだけでよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, reveal, revealCol]);

  /**
   * セルの中身を描く。
   *
   * 探している語があるときだけ切り分けて、当たった所に印を付ける
   */
  /**
   * 1行ぶんの高さしか無いので、セルの中の改行はそのままでは消えてしまう。
   * 見える印にして、値がつながって見えないようにする
   */
  const cellText = (text: string) => {
    const parts = lineParts(text);
    if (parts.length === 1) return mark(text);
    return parts.map((p, i) => (
      <Fragment key={i}>
        {i > 0 && (
          <span className="csv-nl" title="ここで改行しています">
            ↵
          </span>
        )}
        {mark(p)}
      </Fragment>
    ));
  };

  const mark = (text: string) => {
    if (!findQuery) return text;
    const parts = markSegments(text, findQuery, !!findCase);
    if (parts.length === 1 && !parts[0].hit) return text;
    return parts.map((s, i) =>
      s.hit ? (
        <mark className="csv-find-mark" key={i}>
          {s.text}
        </mark>
      ) : (
        <Fragment key={i}>{s.text}</Fragment>
      )
    );
  };

  /**
   * その列の幅を、中身に合わせる (仕切りのダブルクリック)。
   *
   * 全行は手元に無いので、見えているあたりの行を見て決める
   */
  const fitColumn = (c: number) => {
    const to = Math.min(rowCount, first + FIT_SAMPLE);
    const values: string[] = [];
    for (let i = first; i < to; i++) {
      const r = rows.row(i);
      if (r) values.push(r[c] ?? "");
    }
    const w = fitWidth(columns[c] ?? "", values);
    setWidths((prev) => prev.map((v, i) => (i === c ? w : v)));
  };

  const items = [];
  for (let i = first; i < last; i++) {
    const cells = rows.row(i);
    items.push(
      <div
        key={i}
        className={
          "csv-row" +
          (cursor?.row === i ? " current" : "") +
          (rowClass?.(i) ? ` ${rowClass(i)}` : "")
        }
        style={{ top: i * ROW_H, width: total }}
        onContextMenu={(e) => {
          if (!onRowMenu) return;
          e.preventDefault();
          onRowMenu(i, e.clientX, e.clientY, rowBlock(ranges, i));
        }}
      >
        <div
          className={
            "csv-num" +
            (rowInAny(ranges, i) ? " on" : "")
          }
          style={{ width: NUM_W }}
          title="押すとこの行を選びます"
          onMouseDown={(e) => {
            /*
             * ここで押下の既定の動きを止めるので、表に印が移らない。
             * 止めたままだと ⌘C や矢印キーが表に届かないため、自分で移す
             */
            e.preventDefault();
            wrapRef.current?.focus();
            const end = { row: i, col: Math.max(0, columns.length - 1) };
            /*
             * 右押しは、選んでいる中ならそのまま残す (メニューを出すだけ)。
             * 外を押したときは、その行だけを選び直してからメニューを出す
             */
            if (e.button !== 0) {
              if (rowInAny(ranges, i)) return;
              setExtra([]);
              putCursor({ row: i, col: 0 });
              setHead(end);
              return;
            }
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
            putCursor({ row: i, col: 0 });
            setHead(end);
          }}
          onMouseEnter={() => {
            if (dragging.current && rowDrag.current) {
              setHead({ row: i, col: Math.max(0, columns.length - 1) });
            }
          }}
        >
          {rowNumber ? rowNumber(i) : i + 1}
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
              // 押下を止める枝があるので、印は自分で移しておく
              wrapRef.current?.focus();
              /*
               * 右押しは、選んでいる中ならそのまま残す (メニューを出すだけ)。
               * 外を押したときは、そのセルだけを選び直してからメニューを出す
               */
              if (e.button !== 0) {
                if (inAny(ranges, i, c)) return;
                setExtra([]);
                setHead(null);
                putCursor({ row: i, col: c });
                return;
              }
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
              putCursor({ row: i, col: c });
            }}
            onMouseEnter={() => {
              if (dragging.current && !rowDrag.current && !colDrag.current) {
                setHead({ row: i, col: c });
              }
            }}
            onDoubleClick={() => startEdit({ row: i, col: c })}
          >
            {cells === null ? "" : cellText(cells[c] ?? "")}
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
      // 自分で動かし始めたら、前の位置へ合わせ直すのはやめる
      onWheel={() => (pendingLeft.current = null)}
      onMouseDownCapture={() => (pendingLeft.current = null)}
      onKeyDownCapture={() => (pendingLeft.current = null)}
      onScroll={(e) => {
        const { scrollTop: top, scrollLeft: left } = e.currentTarget;
        setScrollTop(top);
        onScrollPos?.(top, left);
        // 横の位置を戻している途中は、戻したい位置のほうを控えておく
        if (memoKey) {
          saveCsvScroll(memoKey, { top, left: pendingLeft.current ?? left });
        }
      }}
    >
      <div className="csv-head" style={{ width: total, height: HEAD_H }}>
        <div
          className={
            "csv-num head" + (rowCount > 0 && columns.length > 0 ? " all" : "")
          }
          style={{ width: NUM_W }}
          title="押すと表全体を選びます (⌘/Ctrl+A)"
          onMouseDown={(e) => {
            // 押下を止めるので、印は自分で移す (⌘C を表へ届かせるため)
            e.preventDefault();
            selectAll();
          }}
        >
          #
        </div>
        {columns.map((name, c) => (
          <div
            key={c}
            className={
              "csv-col" +
              // 選んでいる列 (見出しにも分かるようにする)
              (colInAny(ranges, c) ? " on" : "")
            }
            style={{ left: lefts[c], width: widths[c] }}
            title={name}
            onContextMenu={(e) => {
              if (!onHeaderMenu) return;
              e.preventDefault();
              onHeaderMenu(c, e.clientX, e.clientY, colBlock(ranges, c));
            }}
            onMouseDown={(e) => {
              // 押下を止めるので、印は自分で移す (⌘C を表へ届かせるため)
              e.preventDefault();
              wrapRef.current?.focus();
              const bottom = Math.max(0, rowCount - 1);
              /*
               * 右押しは、選んでいる中ならそのまま残す (メニューを出すだけ)。
               * 外を押したときは、その列だけを選び直してからメニューを出す
               */
              if (e.button !== 0) {
                if (colInAny(ranges, c)) return;
                setExtra([]);
                putCursor({ row: 0, col: c });
                setHead({ row: bottom, col: c });
                return;
              }
              if (e.shiftKey && cursor) {
                setHead({ row: bottom, col: c });
                return;
              }
              // ⌘ を押しながらなら、今までの選択に足す
              if ((e.metaKey || e.ctrlKey) && cursor) {
                setExtra((prev) => [...prev, { a: cursor, b: head ?? cursor }]);
              } else {
                setExtra([]);
              }
              dragging.current = true;
              colDrag.current = true;
              rowDrag.current = false;
              putCursor({ row: 0, col: c });
              setHead({ row: bottom, col: c });
            }}
            onMouseEnter={() => {
              if (dragging.current && colDrag.current) {
                setHead({ row: Math.max(0, rowCount - 1), col: c });
              }
            }}
            onDoubleClick={() => {
              if (!onRename) return;
              dragging.current = false;
              colDrag.current = false;
              setEditHead({ col: c, text: name });
            }}
          >
            {editHead?.col === c ? (
              /* その場で書き換える (Enterで決めて、Escでやめる) */
              <input
                className="csv-col-editor"
                autoFocus
                value={editHead.text}
                onChange={(e) => setEditHead({ col: c, text: e.target.value })}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onBlur={commitHead}
                onKeyDown={(e) => {
                  // 表のキー操作 (矢印やコピー) へは渡さない
                  e.stopPropagation();
                  if (imeBusy(e)) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitHead();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditHead(null);
                  }
                }}
              />
            ) : (
              <span className="csv-col-name">{name}</span>
            )}
            {sortMark?.(c) && (
              <span
                className="csv-col-sort"
                title={
                  sortMark(c) === "desc"
                    ? "大きい順に並べています"
                    : "小さい順に並べています"
                }
              >
                {/* 三角は字で出すと上下がずれるので、絵で描く */}
                <svg width="8" height="8" viewBox="0 0 12 12" aria-hidden>
                  <path
                    d={
                      sortMark(c) === "desc"
                        ? "M6 9L2.5 3.5h7z"
                        : "M6 3l3.5 5.5h-7z"
                    }
                    fill="currentColor"
                  />
                </svg>
              </span>
            )}
            {showFilter && (
              <button
                className={
                  "csv-col-filter" + (isFiltered?.(c) ? " on" : "")
                }
                title={filterTip?.(c) ?? "この列で絞り込む"}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const box = e.currentTarget.getBoundingClientRect();
                  // メニューはつまみの真下に出す
                  onFilter?.(c, box.left, box.bottom + 2, box.top - 2);
                }}
              >
                {/* 升目の真ん中に来るよう、上下の余りを同じにしてある */}
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
                  <path
                    d="M3.8 4h16.4l-6.4 7.9V18l-3.6 2v-8.1z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            )}
            <span
              className="csv-col-grip"
              title="ドラッグで幅を変えます (ダブルクリックで中身に合わせます)"
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                fitColumn(c);
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                // 幅を変えるだけなので、列ごと選ぶ動きへは渡さない
                e.stopPropagation();
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

      {/*
        スクロールの高さ・幅を作るための場所取り (中身は絶対配置で置く)。
        バーが中身に重なって出る環境でだけ、端に余白を足す
      */}
      <div
        className="csv-body"
        style={{
          height: rowCount * ROW_H + edgeGap(),
          width: total + edgeGap(),
        }}
      >
        {/*
          選んでいる範囲を紫の枠で囲む。
          セルに縁を付けると文字がずれるので、上に重ねた枠で描く
        */}
        {ranges.map((r, i) => {
          // 消した行・列を指したままの範囲は、今ある所までに切り詰めて描く
          const shownRange = clipRange(r, rowCount, columns.length);
          if (!shownRange) return null;
          const box = frameBox(shownRange, lefts, widths, ROW_H, NUM_W);
          return <div key={i} className="csv-sel-frame" style={box} />;
        })}
        {items}
        {editing && (
          <textarea
            className="csv-editor mono"
            autoFocus
            ref={editRef}
            value={editing.text}
            spellCheck={false}
            wrap="off"
            style={{
              top: editing.at.row * ROW_H,
              left: lefts[editing.at.col],
              width: widths[editing.at.col],
              // 改行を入れたぶんだけ下へ伸ばす (伸びすぎないよう頭打ちにする)
              height: ROW_H * Math.min(EDIT_MAX_LINES, lineCount(editing.text)),
            }}
            onChange={(e) =>
              setEditing({ at: editing.at, text: e.target.value })
            }
            onKeyDown={(e) => {
              // 変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
              if (imeBusy(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                /*
                 * Option (Windowsでは Alt) を押しながらなら、
                 * セルの中で改行する
                 */
                if (e.altKey) {
                  if (!canNewline) {
                    onDenyNewline?.();
                    return;
                  }
                  const el = e.currentTarget;
                  const got = insertNewline(
                    editing.text,
                    el.selectionStart,
                    el.selectionEnd
                  );
                  caret.current = got.caret;
                  setEditing({ at: editing.at, text: got.text });
                  return;
                }
                // Shift+Enter は上のセルへ (表計算ソフトと同じ)
                commit(e.shiftKey ? "up" : "down");
              } else if (e.key === "Tab") {
                e.preventDefault();
                commit("right");
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(null);
                // やめたときも、続けて矢印キーで動けるように表へ戻す
                wrapRef.current?.focus();
              }
            }}
            onBlur={() => commit("none")}
          />
        )}
      </div>
    </div>
  );
}
