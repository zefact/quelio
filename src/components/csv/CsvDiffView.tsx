/**
 * CSVの比較結果。
 *
 * 左右を別々にスクロールさせると必ずずれるので、
 * 「1つの行の中に左と右を並べる」形にして、スクロールは1つだけにした。
 * これで同期のずれが起きようがない。
 *
 * 行数は10万を超えることがあるため、`CsvGrid` と同じく
 * 見えているぶんだけを描く
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { csvDiffNext } from "../../api";
import { useCsvDiffRows } from "../../hooks/useCsvDiffRows";
import { fitWidth } from "./csvWidth";
import { dragWidth, splitWidths } from "./diffWidths";
import type { CsvDiffOverview, CsvRowStatus } from "../../types";

const ROW_H = 26;
const HEAD_H = 30;
const NUM_W = 60;
const OVERSCAN = 8;
/** 幅を「中身に合わせる」ときに見る行数 (見えているぶんから数える) */
const FIT_SAMPLE = 200;
/** 左右のあいだの溝 */
const GAP = 14;

interface Props {
  overview: CsvDiffOverview;
  /** 比較をやり直すたびに変わる値 */
  token: number;
  leftName: string;
  rightName: string;
  onClose: () => void;
}

/** 行の状態ごとのセルの色 */
function cellClass(status: CsvRowStatus, side: "left" | "right", changed: boolean) {
  if (status === "onlyLeft") return side === "left" ? " diff-removed" : " diff-gap";
  if (status === "onlyRight") return side === "right" ? " diff-added" : " diff-gap";
  return changed ? " diff-changed" : "";
}

export function CsvDiffView({
  overview,
  token,
  leftName,
  rightName,
  onClose,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [note, setNote] = useState<string | null>(null);
  const rows = useCsvDiffRows(token, overview.total);

  /*
   * 列の幅。
   *
   * 左右で同じ列を並べるので、幅も左右で共通。
   * 最初は列名から見当を付け、あとはつまみと仕切りで手で変えられる
   */
  const [widths, setWidths] = useState<number[]>(() =>
    overview.columns.map((c) => fitWidth(c.name, []))
  );
  // 比較をやり直して列が変わったら、幅も付け直す
  useEffect(() => {
    setWidths(overview.columns.map((c) => fitWidth(c.name, [])));
  }, [overview.columns]);
  const side = useMemo(
    () => widths.reduce((a, b) => a + b, NUM_W),
    [widths]
  );
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = NUM_W;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return out;
  }, [widths]);
  const total = side * 2 + GAP;

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
  const last = Math.min(overview.total, first + visible);

  useEffect(() => {
    rows.ensure(first, last);
  }, [rows, first, last]);

  /** その行を画面の真ん中あたりへ持ってくる */
  const reveal = useCallback((row: number) => {
    const el = wrapRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, row * ROW_H - el.clientHeight / 2);
  }, []);

  /*
   * 幅を変えるドラッグ。
   *
   * つまみ (1列だけ) と仕切り (全部まとめて) で、掴んだあとの動きは同じ。
   * 掴んだときの幅を覚えておき、動かすたびにそこからの差で計算し直す
   */
  const grab = (e: React.MouseEvent, compute: (start: number[], dx: number) => number[]) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widths;
    document.body.classList.add("col-resizing");
    const onMove = (m: MouseEvent) => setWidths(compute(start, m.clientX - startX));
    const onUp = () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** その列を、見えている行の中身に合わせた幅にする */
  const fitColumn = (c: number) => {
    const to = Math.min(overview.total, first + FIT_SAMPLE);
    const values: string[] = [];
    for (let i = first; i < to; i++) {
      const d = rows.row(i);
      if (!d) continue;
      // 左右どちらも収まる幅にする (片側だけ見ると、もう片方が切れる)
      values.push(d.leftCells[c] ?? "", d.rightCells[c] ?? "");
    }
    const w = fitWidth(overview.columns[c]?.name ?? "", values);
    setWidths((prev) => prev.map((v, i) => (i === c ? w : v)));
  };

  /** 幅を最初の見当に戻す */
  const resetWidths = () =>
    setWidths(overview.columns.map((c) => fitWidth(c.name, [])));

  /** 列見出しの右端に置く、幅を変えるつまみ */
  const grip = (c: number) => (
    <span
      className="csv-col-grip"
      title="ドラッグで幅を変えます (ダブルクリックで中身に合わせます)"
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        fitColumn(c);
      }}
      onMouseDown={(e) =>
        grab(e, (start, dx) =>
          start.map((v, i) => (i === c ? dragWidth(start[c], dx) : v))
        )
      }
    />
  );

  /** 左右を分ける仕切り (掴むと列の幅がまとめて伸び縮みする) */
  const splitGrip = (
    <span
      className="csv-diff-grip"
      style={{ left: side + GAP / 2 }}
      title="ドラッグで列の幅をまとめて変えます (ダブルクリックで元に戻します)"
      onDoubleClick={(e) => {
        e.preventDefault();
        resetWidths();
      }}
      onMouseDown={(e) => grab(e, splitWidths)}
    />
  );

  const jump = async (backward: boolean) => {
    setNote(null);
    const from = Math.floor(scrollTop / ROW_H) + (backward ? 0 : 1);
    try {
      const at = await csvDiffNext(from, backward);
      if (at === null) setNote("これ以上ありません");
      else reveal(at);
    } catch (e) {
      setNote(String(e));
    }
  };

  const s = overview.summary;
  const diffCount = s.changed + s.onlyLeft + s.onlyRight;

  const items = [];
  for (let i = first; i < last; i++) {
    const d = rows.row(i);
    const status = d?.status ?? "same";
    const changed = new Set(d?.changed ?? []);
    items.push(
      <div
        key={i}
        className={`csv-row diff-${status}`}
        style={{ top: i * ROW_H, width: total }}
      >
        <div className="csv-num" style={{ width: NUM_W }}>
          {d?.left !== null && d?.left !== undefined ? d.left + 1 : ""}
        </div>
        {overview.columns.map((_, c) => (
          <div
            key={`l${c}`}
            className={"csv-cell" + cellClass(status, "left", changed.has(c))}
            style={{ left: lefts[c], width: widths[c] }}
            title={d?.leftCells[c]}
          >
            {d?.leftCells[c] ?? ""}
          </div>
        ))}

        <div className="csv-num diff-right" style={{ left: side + GAP, width: NUM_W }}>
          {d?.right !== null && d?.right !== undefined ? d.right + 1 : ""}
        </div>
        {overview.columns.map((_, c) => (
          <div
            key={`r${c}`}
            className={"csv-cell" + cellClass(status, "right", changed.has(c))}
            style={{ left: side + GAP + lefts[c], width: widths[c] }}
            title={d?.rightCells[c]}
          >
            {d?.rightCells[c] ?? ""}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="csv-diff">
      <div className="csv-toolbar">
        <strong>比較結果</strong>
        <span className="csv-diff-count changed">変更 {s.changed.toLocaleString()}</span>
        <span className="csv-diff-count removed">左だけ {s.onlyLeft.toLocaleString()}</span>
        <span className="csv-diff-count added">右だけ {s.onlyRight.toLocaleString()}</span>
        <span className="csv-diff-count">一致 {s.same.toLocaleString()}</span>

        <span className="csv-sep" />
        <button className="btn-secondary" disabled={!diffCount} onClick={() => void jump(true)}>
          前の差分
        </button>
        <button className="btn-secondary" disabled={!diffCount} onClick={() => void jump(false)}>
          次の差分
        </button>

        {overview.duplicateKeys > 0 && (
          <span className="csv-warn" title="同じキーの行が複数あります">
            キーの重複 {overview.duplicateKeys.toLocaleString()}
          </span>
        )}
        {overview.columnMismatch && (
          <span className="csv-warn" title="片側にしか無い列は空欄で並べています">
            列が揃っていません
          </span>
        )}
        {note && <span className="csv-find-note">{note}</span>}

        <span className="toolbar-spacer" />
        <button className="btn-ghost" onClick={onClose}>
          閉じる
        </button>
      </div>

      {rows.error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <span className="result-detail">{rows.error}</span>
        </div>
      )}

      <div
        className="csv-grid"
        ref={wrapRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className="csv-head" style={{ width: total, height: HEAD_H }}>
          <div className="csv-num head" style={{ width: NUM_W }}>
            #
          </div>
          {overview.columns.map((c, i) => (
            <div
              key={`lh${i}`}
              className="csv-col"
              style={{ left: lefts[i], width: widths[i] }}
              title={`${c.name} (左)`}
            >
              <span className="csv-col-name">{c.name}</span>
              {grip(i)}
            </div>
          ))}
          <div
            className="csv-num head diff-right"
            style={{ left: side + GAP, width: NUM_W }}
          >
            #
          </div>
          {overview.columns.map((c, i) => (
            <div
              key={`rh${i}`}
              className="csv-col"
              style={{ left: side + GAP + lefts[i], width: widths[i] }}
              title={`${c.name} (右)`}
            >
              <span className="csv-col-name">{c.name}</span>
              {grip(i)}
            </div>
          ))}
          <div className="csv-diff-split" style={{ left: side + GAP / 2 }} />
          {splitGrip}
        </div>

        <div
          className="csv-body"
          style={{ height: overview.total * ROW_H, width: total }}
        >
          <div className="csv-diff-split" style={{ left: side + GAP / 2 }} />
          {splitGrip}
          {items}
        </div>
      </div>

      <div className="csv-status">
        <span className="csv-diff-side">左 {leftName}</span>
        <span className="csv-diff-side">右 {rightName}</span>
        <span className="toolbar-spacer" />
        <span className="mono">{overview.total.toLocaleString()}行</span>
      </div>
    </div>
  );
}
