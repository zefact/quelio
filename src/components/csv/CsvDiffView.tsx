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
import type { CsvDiffOverview, CsvRowStatus } from "../../types";

const ROW_H = 26;
const HEAD_H = 30;
const NUM_W = 60;
const MIN_W = 70;
const MAX_W = 300;
const OVERSCAN = 8;
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

  const widths = useMemo(
    () =>
      overview.columns.map((c) =>
        Math.min(MAX_W, Math.max(MIN_W, c.name.length * 9 + 24))
      ),
    [overview.columns]
  );
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
            </div>
          ))}
          <div className="csv-diff-split" style={{ left: side + GAP / 2 }} />
        </div>

        <div
          className="csv-body"
          style={{ height: overview.total * ROW_H, width: total }}
        >
          <div className="csv-diff-split" style={{ left: side + GAP / 2 }} />
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
