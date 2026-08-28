import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { translateY } from "../domTransform";
import { rafThrottle } from "../rafThrottle";
import { usePopupPosition } from "../hooks/usePopupPosition";
import {
  readCells,
  toInsert,
  toJson,
  toMarkdown,
  toTsv,
  writeClipboard,
  type CopyFormat,
} from "../gridCopy";

import type { DbType } from "../types";
import { HoverTip } from "./HoverTip";
import { useDismiss } from "../hooks/useDismiss";

export interface GridColumn {
  id: string;
  label: string;
  /** 初期幅(px) */
  width: number;
  minWidth?: number;
  align?: "left" | "center" | "right";
  /** trueで折り返して全文表示 (コメント列など) */
  wrap?: boolean;
  /** ヘッダにマウスを乗せたときの説明ツールチップ */
  description?: string;
  /** ヘッダ・セルに追加で付けるclass (行番号列など見た目を分けたい列に使う) */
  cellClass?: string;
  /** falseならソートメニューを出さない (行番号列など) */
  sortable?: boolean;
  /** trueならコピー対象に含めない (行番号列など) */
  excludeFromCopy?: boolean;
}

/** ソートメニューで選べる並び順 (nullはソートなし) */
export type SortDir = "asc" | "desc" | null;

export interface GridRow {
  key: string;
  cells: ReactNode[];
  /** 行に追加するclass (編集中の行を目立たせる等) */
  className?: string;
}

/** 行の右クリックメニューの項目 */
export interface RowMenuItem {
  label: string;
  /** 取り消せない操作は赤くする */
  danger?: boolean;
  disabled?: boolean;
  /** 無効なときの理由など */
  title?: string;
  onSelect: () => void;
}

export interface SortState {
  id: string;
  dir: "asc" | "desc";
}

interface Props {
  columns: GridColumn[];
  rows: GridRow[];
  emptyText?: string;
  /** 現在のソート状態 (ヘッダの矢印表示に使う) */
  sort?: SortState | null;
  /** 指定するとヘッダクリックでソートメニューを開き、選択結果を通知する */
  onSortSelect?: (id: string, dir: SortDir) => void;
  /** trueなら初期表示時に全列を内容にフィットさせる */
  autoFit?: boolean;
  /** autoFit時、この値が変わったときだけ測り直す (未指定なら描画のたびに測る) */
  fitKey?: string | number;
  /**
   * trueなら行を選択できるようにする。
   * クリックで選択 (⌘/Ctrl+クリックで追加、Shift+クリックで範囲)、
   * ⌘/Ctrl+Aで全選択、⌘/Ctrl+Cで選択行 (未選択なら全行) をコピー
   */
  selectable?: boolean;
  /** セルのダブルクリック通知 (行単位のインライン編集を始めるのに使う) */
  onCellDoubleClick?: (rowKey: string, columnId: string) => void;
  /** 行の右クリックメニューの見出し (省略可) */
  rowMenuHead?: (rowKey: string, index: number) => string | undefined;
  /**
   * 行の右クリックメニューに足す項目。
   * コピー項目は常にこの下へ並ぶので、画面ごとにメニューを作り分けなくてよい
   */
  rowMenuItems?: (rowKey: string, index: number) => RowMenuItem[];
  /**
   * 行(tr)に追加で付けるDOM属性を返す。
   * ドラッグでの並べ替え (onDragOver/onDrop など) に使う。
   * classNameは行のclassに足される
   */
  rowProps?: (
    rowKey: string,
    index: number
  ) => React.HTMLAttributes<HTMLTableRowElement>;
  /** trueなら行の並びが変わったときに、その場から滑らかに動かす */
  animateRows?: boolean;
  /**
   * 一度に描画する行数の上限。
   * 指定すると最初はこの行数だけ描き、下端までスクロールするたびに継ぎ足す。
   * (1000行×数十列を一度にDOMへ出すと初期表示とスクロールが重いため)
   */
  maxRenderRows?: number;
  /** 上限で切られていても、末尾の1行 (追加中の行など) は必ず描く */
  pinLastRow?: boolean;
  /**
   * INSERT文でコピーするときの対象 (クォート済みのテーブル名)。
   * 行がどの表のものか決まっている画面 (データタブ) でだけ渡す
   */
  insertTable?: string;
  /** INSERT文でコピーするときの列名 (クォート済み。列の並びと対応させる) */
  insertColumn?: (columnId: string, label: string) => string;
  /** INSERT文の文字列リテラルの書き方を決める (MySQLだけ扱いが違う) */
  insertDbType?: DbType;
  /**
   * 値が切り詰められている行のキー。
   * コピーの完了メッセージに「先頭までです」と添えるのに使う
   */
  clippedRowKeys?: Set<string>;
  /** 外枠(スクロールする要素)に足すclass */
  wrapClass?: string;
  /**
   * 外枠(スクロールする要素)を呼び出し側から触れるようにする。
   * 表示範囲を自前で決める画面 (コンソール) で使う
   */
  wrapRefOut?: { current: HTMLDivElement | null };
  /** 外枠のスクロール通知 (自前の読み込み位置の調整に使う) */
  onScroll?: () => void;
  /**
   * trueなら行数が変わっても選択を保つ。
   * 行キーが安定していて、末尾に追記していくだけの画面 (コンソール) 用
   */
  stableRowKeys?: boolean;
}

/** ソートメニューの選択肢 */
const SORT_ITEMS: [SortDir, string][] = [
  ["asc", "昇順で並び替え (小 → 大 / A → Z)"],
  ["desc", "降順で並び替え (大 → 小 / Z → A)"],
  [null, "ソートなし (取得順)"],
];

/** ダブルクリックfit時の最大幅 */
const FIT_MAX = 700;

/** 幅の自動フィットで計測する最大行数 (1000行を全て測ると重いため) */
const FIT_SAMPLE = 200;

/** 列が多い場合の下限サンプル行数 */
const FIT_MIN_SAMPLE = 30;

/** 自動フィット1回あたりに計測するセル数の目安 (列数に応じて行数を減らす) */
const FIT_CELL_BUDGET = 4000;

/** 続きを描画するときに一度に足す行数 */
const RENDER_STEP = 200;

/** 下端からこの距離まで来たら続きを描画する(px) */
const RENDER_MARGIN = 400;

/** 列幅をドラッグで変更できるテーブル。
 *  コンテナが広い場合は最後の列が伸びて幅いっぱいに広がる。
 *  リサイザをダブルクリックするとその列を内容にフィットさせる。 */
export function ResizableGrid({
  columns,
  rows,
  emptyText,
  sort,
  onSortSelect,
  autoFit,
  fitKey,
  selectable,
  onCellDoubleClick,
  rowMenuHead,
  rowMenuItems,
  rowProps,
  animateRows,
  maxRenderRows,
  pinLastRow,
  insertTable,
  insertColumn,
  insertDbType,
  clippedRowKeys,
  wrapClass,
  wrapRefOut,
  onScroll,
  stableRowKeys,
}: Props) {
  /** 開いているソートメニュー (対象列と表示位置) */
  const [sortMenu, setSortMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  /** 選択中の行キー */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * Shift+クリックの基準行 (行キーで持つ)。
   * 位置で持つと、表示範囲がずれる画面で別の行が基準になってしまう
   */
  const [anchor, setAnchor] = useState<string | null>(null);
  /** 行の右クリックメニューの表示位置と対象行 */
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    key: string;
    index: number;
  } | null>(null);
  // メニューが画面の外へはみ出さないように位置を補正する
  const [rowMenuRef, rowMenuStyle] = usePopupPosition<HTMLDivElement>(
    rowMenu?.x ?? 0,
    rowMenu?.y ?? 0
  );
  const [sortMenuRef, sortMenuStyle] = usePopupPosition<HTMLDivElement>(
    sortMenu?.x ?? 0,
    sortMenu?.y ?? 0
  );
  /** コピー結果の一時表示 */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(columns.map((c) => [c.id, c.width]))
  );

  // 列構成が変わった場合 (表示モード切替など) に新しい列の幅を補う
  useEffect(() => {
    setWidths((w) => {
      let changed = false;
      const next = { ...w };
      for (const c of columns) {
        if (next[c.id] === undefined) {
          next[c.id] = c.width;
          changed = true;
        }
      }
      return changed ? next : w;
    });
  }, [columns]);
  const dragging = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // ---------- 描画行数の制限 (maxRenderRows指定時のみ) ----------

  /** 実際に描画している行数 (下端までスクロールすると増える) */
  const [shown, setShown] = useState(maxRenderRows ?? Number.MAX_SAFE_INTEGER);
  /** 表示中のデータ・並び順が入れ替わったら先頭ぶんだけに戻す
   *  (行の編集など、同じデータのままの再描画では戻さない) */
  const dataKey = `${fitKey ?? ""}\u0000${sort?.id ?? ""}:${sort?.dir ?? ""}`;
  const shownDataKey = useRef(dataKey);
  useEffect(() => {
    if (!maxRenderRows || shownDataKey.current === dataKey) return;
    shownDataKey.current = dataKey;
    // 描画ぶんが実際に縮むときだけ、スクロール位置も先頭へ戻す
    if (shown > maxRenderRows && wrapRef.current) {
      wrapRef.current.scrollTop = 0;
    }
    setShown(maxRenderRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, maxRenderRows]);
  const limited =
    !!maxRenderRows && shown < rows.length && rows.length > 0;
  /** まだ描いていない行数 (末尾の固定行は除く) */
  const restCount = limited ? rows.length - shown - (pinLastRow ? 1 : 0) : 0;
  const visibleRows = !limited
    ? rows
    : pinLastRow
      ? // 追加中の行は末尾にあるので、切り詰めたうえで足す
        [...rows.slice(0, shown), rows[rows.length - 1]]
      : rows.slice(0, shown);

  /** 下端に近づいていれば続きを描画する */
  const growIfNeeded = () => {
    const el = wrapRef.current;
    if (!el || restCount === 0) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < RENDER_MARGIN) {
      setShown((n) => Math.min(rows.length, n + RENDER_STEP));
    }
  };

  // 描画ぶんが画面より短いとスクロールできず続きを出せないため、
  // 収まっているあいだは足し続ける (ウィンドウが大きい場合の対策)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || restCount === 0) return;
    // 非表示 (エディタ最大化など) のときは測れないので何もしない
    if (el.clientHeight === 0) return;
    if (el.scrollHeight - el.clientHeight < 8) {
      setShown((n) => Math.min(rows.length, n + RENDER_STEP));
    }
  }, [restCount, rows.length, containerW, containerH]);

  // 行の並びが変わったとき、旧位置から新位置へ滑らかに動かす (FLIP)。
  // 「一度ずらしてから元に戻す」ことで、レイアウトはそのままに動きだけ付ける
  const prevTops = useRef<Map<string, number>>(new Map());
  const orderKey = visibleRows.map((r) => r.key).join("\u0000");
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!animateRows || !table) return;
    const trs = Array.from(
      table.querySelectorAll<HTMLTableRowElement>("tbody > tr[data-row-key]")
    );
    const next = new Map<string, number>();
    const moves: [HTMLTableRowElement, number][] = [];
    for (const tr of trs) {
      const key = tr.dataset.rowKey;
      if (!key) continue;
      const top = tr.offsetTop;
      next.set(key, top);
      const prev = prevTops.current.get(key);
      if (prev === undefined) continue;
      // ポインタで直接動かしている行は、そちらに任せる (二重に動かさない)
      if (tr.dataset.pointerDrag === "1") continue;
      // 前のアニメーションが動いている途中なら、その「見えている位置」から続ける
      // (レイアウト上の旧位置へ戻すと、そこへ一瞬飛んでカクついて見えるため)
      const shown = prev + translateY(tr);
      if (Math.abs(shown - top) >= 0.5) moves.push([tr, shown - top]);
    }
    prevTops.current = next;
    if (moves.length === 0) return;

    // まず見えている位置へ戻してから、次のフレームで新位置へ動かす
    for (const [tr, dy] of moves) {
      tr.style.transition = "none";
      tr.style.transform = `translateY(${dy}px)`;
      tr.style.willChange = "transform";
    }
    const raf = requestAnimationFrame(() => {
      for (const [tr] of moves) {
        tr.style.transition = "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)";
        tr.style.transform = "";
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [orderKey, animateRows]);

  // コンテナ幅を監視 (ウィンドウリサイズやペイン幅変更に追従)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      setContainerW(el.clientWidth);
      setContainerH(el.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const startResize = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    const startX = e.clientX;
    const startW = widths[id];
    const min = columns.find((c) => c.id === id)?.minWidth ?? 50;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";

    // mousemoveは1フレームに何度も来るので、更新は1フレーム1回に間引く
    const widthAt = (x: number) => Math.max(min, startW + x - startX);
    const apply = rafThrottle((x: number) =>
      setWidths((w) => {
        const next = widthAt(x);
        return w[id] === next ? w : { ...w, [id]: next };
      })
    );
    let lastX = startX;
    const move = (ev: MouseEvent) => {
      lastX = ev.clientX;
      apply.run(ev.clientX);
    };
    const up = () => {
      dragging.current = false;
      // 間引きで取りこぼした最後の位置をここで確定させる
      apply.cancel();
      setWidths((w) => ({ ...w, [id]: widthAt(lastX) }));
      document.removeEventListener("mousemove", move);
      document.body.style.cursor = prevCursor;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 列インデックスの内容フィット幅を計測する (DOM未描画ならnull) */
  const measureColumn = (idx: number): number | null => {
    const table = tableRef.current;
    if (!table || idx < 0) return null;
    const all = table.querySelectorAll(
      `tr:not(.grid-more) > *:nth-child(${idx + 1})`
    ) as NodeListOf<HTMLElement>;
    if (all.length === 0) return null;
    // 行数・列数が多いと計測に時間がかかるため、先頭の数行だけで幅を決める。
    // 列が多いほどサンプル行数を減らし、全体の計測セル数を一定に抑える
    // (先頭要素はヘッダなので、ヘッダの文字幅は常に反映される)
    const sample = Math.max(
      FIT_MIN_SAMPLE,
      Math.min(FIT_SAMPLE, Math.floor(FIT_CELL_BUDGET / Math.max(1, columns.length)))
    );
    const cells = Array.from(all).slice(0, sample);

    // 計測用の非表示スパンで各セルのテキスト幅を測る。
    // フォントはセル内の実要素(等幅spanなど)から個別プロパティで引き継ぐ
    // (WebKitはfontショートハンドの取得が不安定なため)
    const meas = document.createElement("span");
    meas.style.cssText =
      "position:absolute;visibility:hidden;white-space:nowrap;left:-99999px;";
    document.body.appendChild(meas);
    let max = 40;
    // 同じ見た目のセルが続く間は算出済みスタイルの取得を省く (計測の高速化)
    let styleKey = "";
    let pad = 0;
    cells.forEach((cell) => {
      const inner = (cell.firstElementChild as HTMLElement | null) ?? cell;
      const key = `${cell.className}|${inner.tagName}.${inner.className}`;
      if (key !== styleKey) {
        styleKey = key;
        const fs = getComputedStyle(inner);
        meas.style.fontFamily = fs.fontFamily;
        meas.style.fontSize = fs.fontSize;
        meas.style.fontWeight = fs.fontWeight;
        meas.style.fontStyle = fs.fontStyle;
        meas.style.letterSpacing = fs.letterSpacing;
        const cs = getComputedStyle(cell);
        pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      }
      meas.textContent = cell.textContent ?? "";
      max = Math.max(max, meas.offsetWidth + pad + 12);
    });
    meas.remove();

    const min = columns[idx].minWidth ?? 50;
    return Math.min(FIT_MAX, Math.max(min, Math.ceil(max)));
  };

  /** リサイザのダブルクリックで列幅を内容にフィットさせる */
  const fitColumn = (id: string) => {
    const idx = columns.findIndex((c) => c.id === id);
    const w = measureColumn(idx);
    if (w !== null) {
      setWidths((prev) => ({ ...prev, [id]: w }));
    }
  };

  // autoFit: 行が描画されたら全列を内容にフィットさせる
  // (fitKey指定時はその値が変わったときだけ測り直す。入力中の再描画などで
  //  毎回測り直すと重いため)
  const fittedKey = useRef<string | number | null>(null);
  useEffect(() => {
    if (!autoFit || rows.length === 0) return;
    if (fitKey !== undefined && fittedKey.current === fitKey) return;
    const raf = requestAnimationFrame(() => {
      // 計測が実際に走ってから記録する。
      // (StrictModeの二重実行ではrAFがキャンセルされるため、
      //  先に記録すると2回目が空振りして一度も計測されない)
      fittedKey.current = fitKey ?? null;
      setWidths((prev) => {
        const next = { ...prev };
        let changed = false;
        columns.forEach((c, i) => {
          const w = measureColumn(i);
          if (w !== null && next[c.id] !== w) {
            next[c.id] = w;
            changed = true;
          }
        });
        // 幅が変わらない場合は同じオブジェクトを返して再描画を止める
        return changed ? next : prev;
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFit, fitKey, rows, columns]);

  // ---------- 行の選択とコピー ----------

  /*
   * 表示内容が入れ替わったら選択を解除する。
   *
   * 行キーは画面によっては通し番号なので、行数だけを見ていると
   * ページ送り (行数は同じで中身が違う) で選択が残り、
   * 別の行をコピーしてしまう。そこで fitKey も見ている。
   * ※ 呼び出し側は「取得内容が変わったら fitKey も変える」こと
   *   (データタブは offset と並び順、SQL結果は実行時刻を含めている)
   *
   * stableRowKeys のときは行キーが行の中身と1対1なので、
   * 行数が増えても取り違えは起きない (追記のたびに選択が消えないようにする)
   */
  const rowsSig = stableRowKeys ? 0 : rows.length;
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [fitKey, rowsSig, columns.length]);

  /*
   * 行キーが安定している画面では、選択を消す代わりに
   * 「もう表示していない行」だけを選択から外す。
   * 残しておくと、コピーしても何も起きない (DOMに無い) 状態になる
   */
  useEffect(() => {
    if (!stableRowKeys) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const keys = new Set(rows.map((r) => r.key));
      const next = new Set([...prev].filter((k) => keys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [stableRowKeys, rows]);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    []
  );

  /** 短いメッセージを一時表示する */
  const flash = (message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };

  /** 行クリック (⌘/Ctrl: 追加/解除, Shift: 範囲, 通常: 単一選択) */
  const handleRowClick = (e: React.MouseEvent, key: string, idx: number) => {
    if (!selectable) return;
    // キー操作(⌘+C / ⌘+A)を受け取れるようにフォーカスを移す
    wrapRef.current?.focus();
    if (e.metaKey || e.ctrlKey) {
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setAnchor(key);
      return;
    }
    const anchorIdx =
      anchor === null ? -1 : rows.findIndex((r) => r.key === anchor);
    // 基準行が表示から外れていたら、範囲選択はせず1行だけ選び直す
    if (e.shiftKey && anchorIdx >= 0) {
      // Shift+クリックで伸びた文字列選択が残らないようにする
      window.getSelection()?.removeAllRanges();
      const [from, to] = [
        Math.min(anchorIdx, idx),
        Math.max(anchorIdx, idx),
      ];
      setSelected(new Set(rows.slice(from, to + 1).map((r) => r.key)));
      return;
    }
    // 同じ行をもう一度クリックしたら選択解除
    setSelected((cur) =>
      cur.size === 1 && cur.has(key) ? new Set() : new Set([key])
    );
    setAnchor(key);
  };

  /** コピー対象の行数 (選択が無ければ表示中の全行) */
  const copyCount = selected.size > 0 ? selected.size : rows.length;

  /** 形式ごとの呼び名 (完了メッセージに使う) */
  const FORMAT_LABEL: Record<CopyFormat, string> = {
    tsv: "",
    tsvHeader: "ヘッダー付きで",
    json: "JSONで",
    markdown: "Markdownの表で",
    insert: "INSERT文で",
  };

  /** 選択行 (未選択なら全行) を指定の形式でクリップボードへコピーする */
  const copyRows = (format: CopyFormat) => {
    setRowMenu(null);
    // 描画を絞っている場合、DOMに無い行はコピーできないので先に全行を描く
    if (limited) flushSync(() => setShown(rows.length));
    const table = tableRef.current;
    if (!table) return;
    const trs = Array.from(
      table.querySelectorAll("tbody tr[data-row-key]")
    ) as HTMLElement[];
    const targets =
      selected.size > 0
        ? trs.filter((tr) => selected.has(tr.dataset.rowKey ?? ""))
        : trs;
    if (targets.length === 0) return;
    const cols = columns
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.excludeFromCopy);
    const labels = cols.map(({ c }) => c.label);
    const data = readCells(
      targets,
      cols.map(({ i }) => i)
    );
    let text: string;
    if (format === "json") text = toJson(data, labels);
    else if (format === "markdown") text = toMarkdown(data, labels);
    else if (format === "insert") {
      if (!insertTable) return;
      text = toInsert(
        data,
        insertTable,
        cols.map(({ c }) => insertColumn?.(c.id, c.label) ?? c.label),
        insertDbType
      );
    } else text = toTsv(data, format === "tsvHeader" ? labels : undefined);
    // 長すぎて切り詰められた値は、画面と同じ「先頭だけ」がコピーされる
    const clipped =
      !!clippedRowKeys &&
      targets.some((tr) => clippedRowKeys.has(tr.dataset.rowKey ?? ""));
    writeClipboard(text)
      .then(() =>
        flash(
          `${selected.size > 0 ? `選択した${targets.length}行` : `${targets.length}行すべて`}を${
            FORMAT_LABEL[format]
          }コピーしました${clipped ? " (長い値は先頭までです)" : ""}`
        )
      )
      .catch(() => flash("コピーできませんでした"));
  };

  /** 行の右クリック: 未選択の行なら選択してからメニューを出す */
  const handleRowContextMenu = (
    e: React.MouseEvent,
    key: string,
    idx: number
  ) => {
    if (!selectable && !rowMenuItems) return;
    // 選択もできず項目も無いなら、空のメニューを出しても意味が無い
    if (!selectable && (rowMenuItems?.(key, idx) ?? []).length === 0) return;
    e.preventDefault();
    if (selectable) {
      wrapRef.current?.focus();
      if (!selected.has(key)) {
        setSelected(new Set([key]));
        setAnchor(key);
      }
    }
    setRowMenu({ x: e.clientX, y: e.clientY, key, index: idx });
  };

  /** ⌘/Ctrl+A で全選択、⌘/Ctrl+C でコピー */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!selectable || !(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "a") {
      e.preventDefault();
      setSelected(new Set(rows.map((r) => r.key)));
      setAnchor(rows[0]?.key ?? null);
    } else if (key === "c") {
      // セル内の文字を範囲選択しているときは通常のコピーに任せる
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      e.preventDefault();
      copyRows("tsv");
    }
  };

  /*
   * 各メニューは外側クリック・Escape・リサイズで閉じる。
   *
   * キャプチャ段階で見るのは、モーダルの中でも閉じられるようにするため。
   * モーダルは「背景クリックで閉じる」ために内側の mousedown を
   * stopPropagation しており、バブル段階まで届かない
   * (メニューは body 直下へ出しているので、モーダルとは兄弟になる)。
   * キャプチャで見るとメニュー自身の stopPropagation も効かなくなるので、
   * 内側は `inside` で除く
   */
  useDismiss(
    !!sortMenu || !!rowMenu,
    () => {
      setSortMenu(null);
      setRowMenu(null);
    },
    { capture: true, inside: ".context-menu", resize: true, escape: true }
  );

  // コンテナに余りがある場合は最後の列を伸ばして幅いっぱいにする
  const lastId = columns[columns.length - 1]?.id;
  const sumOthers = columns
    .slice(0, -1)
    .reduce((sum, c) => sum + widths[c.id], 0);
  const lastW = lastId
    ? Math.max(widths[lastId], containerW - sumOthers - 2)
    : 0;
  const renderW = (id: string) => (id === lastId ? lastW : widths[id]);
  const total = sumOthers + lastW;

  return (
    <div
      className={
        "grid-wrap" +
        (selectable ? " selectable" : "") +
        (wrapClass ? ` ${wrapClass}` : "")
      }
      ref={(el) => {
        wrapRef.current = el;
        if (wrapRefOut) wrapRefOut.current = el;
      }}
      tabIndex={selectable ? 0 : undefined}
      onKeyDown={selectable ? handleKeyDown : undefined}
      onScroll={
        maxRenderRows || onScroll
          ? () => {
              if (maxRenderRows) growIfNeeded();
              onScroll?.();
            }
          : undefined
      }
    >
      <table
        ref={tableRef}
        className="grid resizable"
        style={{ width: total, tableLayout: "fixed" }}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={{ width: renderW(c.id) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => {
              const canSort = !!onSortSelect && c.sortable !== false;
              return (
              <th
                key={c.id}
                className={
                  (c.align ?? "") +
                  (canSort ? " sortable" : "") +
                  (c.cellClass ? ` ${c.cellClass}` : "")
                }
                onClick={
                  canSort
                    ? (e) => {
                        const r = (
                          e.currentTarget as HTMLElement
                        ).getBoundingClientRect();
                        setSortMenu((cur) =>
                          cur?.id === c.id
                            ? null
                            : { id: c.id, x: r.left, y: r.bottom + 2 }
                        );
                      }
                    : undefined
                }
              >
                {/* ソートメニューを開いている列はツールチップを出さない (メニューと重なるため) */}
                <HoverTip
                  className="th-label"
                  text={c.description}
                  disabled={sortMenu?.id === c.id}
                >
                  {c.label}
                  {/* 並び替え中の列だけ、方向を矢印で示す */}
                  {sort?.id === c.id && (
                    <span
                      className="sort-arrow"
                      title={sort.dir === "asc" ? "昇順" : "降順"}
                    >
                      {sort.dir === "asc" ? "▲" : "▼"}
                    </span>
                  )}
                </HoverTip>
                <span
                  className="col-resizer"
                  title="ドラッグで幅変更 / ダブルクリックで内容にフィット"
                  onMouseDown={(e) => startResize(c.id, e)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    fitColumn(c.id);
                  }}
                />
              </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((r, i) => {
            // 末尾に固定した行は、元の配列での位置を渡す
            const rowIdx =
              limited && pinLastRow && i === visibleRows.length - 1
                ? rows.length - 1
                : i;
            const extra = rowProps?.(r.key, rowIdx) ?? {};
            return (
            <tr
              key={r.key}
              data-row-key={r.key}
              {...extra}
              className={
                [
                  selected.has(r.key) ? "selected" : "",
                  r.className,
                  extra.className,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              // Shift+クリックはブラウザ標準の文字列選択が伸びてしまうため、
              // mousedownの既定動作を止める (フォーカスはクリック処理で移す)
              onMouseDown={
                selectable
                  ? (e) => {
                      if (e.shiftKey) e.preventDefault();
                    }
                  : undefined
              }
              onClick={
                selectable
                  ? (e) => handleRowClick(e, r.key, rowIdx)
                  : undefined
              }
              onContextMenu={
                selectable || rowMenuItems
                  ? (e) => handleRowContextMenu(e, r.key, rowIdx)
                  : undefined
              }
            >
              {r.cells.map((cell, i) => {
                const c = columns[i];
                const cls = [c.align ?? "", c.wrap ? "wrap" : "", c.cellClass]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td
                    key={c.id}
                    className={cls}
                    onDoubleClick={
                      onCellDoubleClick
                        ? () => onCellDoubleClick(r.key, c.id)
                        : undefined
                    }
                  >
                    {cell}
                  </td>
                );
              })}
            </tr>
            );
          })}
          {restCount > 0 && (
            <tr className="grid-more">
              <td colSpan={columns.length}>
                {shown.toLocaleString()} / {rows.length.toLocaleString()}
                行を表示中 — スクロールすると続きを表示します
              </td>
            </tr>
          )}
          {rows.length === 0 && emptyText && (
            <tr>
              <td colSpan={columns.length} className="faint">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* ヘッダクリックで開くソートメニュー (body直下に出してクリップを避ける) */}
      {sortMenu &&
        onSortSelect &&
        createPortal(
          <div
            className="context-menu grid-sort-menu"
            ref={sortMenuRef}
            style={sortMenuStyle}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="grid-sort-head">
              {columns.find((c) => c.id === sortMenu.id)?.label}
            </div>
            {SORT_ITEMS.map(([dir, label]) => {
              const current = sort?.id === sortMenu.id ? sort.dir : null;
              return (
                <button
                  key={label}
                  className={
                    "context-item" + (current === dir ? " checked" : "")
                  }
                  onClick={() => {
                    setSortMenu(null);
                    onSortSelect(sortMenu.id, dir);
                  }}
                >
                  {current === dir ? "✓ " : ""}
                  {label}
                </button>
              );
            })}
          </div>,
          document.body
        )}

      {/* 行の右クリックメニュー (コピー方法を選ぶ) */}
      {rowMenu &&
        (() => {
          const head = rowMenuHead?.(rowMenu.key, rowMenu.index);
          const items = rowMenuItems?.(rowMenu.key, rowMenu.index) ?? [];
          return createPortal(
            <div
              className="context-menu grid-row-menu"
              ref={rowMenuRef}
              style={rowMenuStyle}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {head && <div className="grid-sort-head mono">{head}</div>}
              {items.map((it) => (
                <button
                  key={it.label}
                  className={"context-item" + (it.danger ? " danger" : "")}
                  disabled={it.disabled}
                  title={it.title}
                  onClick={() => {
                    setRowMenu(null);
                    it.onSelect();
                  }}
                >
                  {it.label}
                </button>
              ))}
              {/* コピーはどの画面でも同じ位置に出す */}
              {selectable && (
                <>
                  {items.length > 0 && <div className="context-sep" />}
                  <div className="grid-sort-head">
                    {selected.size > 0
                      ? `選択中の${copyCount}行`
                      : `表示中の${copyCount}行すべて`}
                  </div>
                  <button
                    className="context-item"
                    onClick={() => copyRows("tsv")}
                  >
                    データをコピー
                  </button>
                  <button
                    className="context-item"
                    onClick={() => copyRows("tsvHeader")}
                  >
                    ヘッダー付きでコピー
                  </button>
                  <button
                    className="context-item"
                    title="1行1オブジェクトの配列。NULLは null になります"
                    onClick={() => copyRows("json")}
                  >
                    JSONでコピー
                  </button>
                  <button
                    className="context-item"
                    title="Markdownの表。改行は <br> に置き換えます"
                    onClick={() => copyRows("markdown")}
                  >
                    Markdownの表でコピー
                  </button>
                  {insertTable && (
                    <button
                      className="context-item"
                      title="値はすべて文字列リテラルにします (型はDB側が解釈します)"
                      onClick={() => copyRows("insert")}
                    >
                      INSERT文でコピー
                    </button>
                  )}
                </>
              )}
            </div>,
            document.body
          );
        })()}

      {/* コピー結果の一時表示 */}
      {toast && createPortal(<div className="grid-toast">{toast}</div>, document.body)}
    </div>
  );
}
