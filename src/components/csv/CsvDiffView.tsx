/**
 * CSVの比較結果。
 *
 * 左右をそれぞれの枠に入れて、真ん中で分ける。
 * 枠ごとに横へ動かせるが、縦も横も位置は必ず合わせるので、
 * どちらを動かしても同じ行・同じ列が向かい合ったまま並ぶ。
 *
 * 行数は10万を超えることがあるため、`CsvGrid` と同じく
 * 見えているぶんだけを描く
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { csvDiffNext } from "../../api";
import { useCsvDiffRows } from "../../hooks/useCsvDiffRows";
import { fitWidth } from "./csvWidth";
import { dragWidth } from "./diffWidths";
import type { CsvDiffOverview, CsvRowStatus } from "../../types";

const ROW_H = 26;
const HEAD_H = 30;
const NUM_W = 60;
const OVERSCAN = 8;
/** 幅を「中身に合わせる」ときに見る行数 (見えているぶんから数える) */
const FIT_SAMPLE = 200;
/** 左側に取れる幅の割合の下限・上限 (片側が潰れないように) */
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

/** どちら側か */
type Side = "left" | "right";

interface Props {
  overview: CsvDiffOverview;
  /** 比較をやり直すたびに変わる値 */
  token: number;
  leftName: string;
  rightName: string;
  onClose: () => void;
}

/** 行の状態ごとのセルの色 */
function cellClass(status: CsvRowStatus, side: Side, changed: boolean) {
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
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  /** 左側が使う幅の割合 (真ん中の仕切りを掴んで動かす) */
  const [leftRatio, setLeftRatio] = useState(0.5);
  const [note, setNote] = useState<string | null>(null);
  const rows = useCsvDiffRows(token, overview.total);

  /*
   * 列の幅。
   *
   * 左右で同じ列を並べるので、幅も左右で共通。
   * 最初は列名から見当を付け、あとは見出しのつまみで変えられる
   * (真ん中の仕切りは幅ではなく、左右の取り分だけを変える)
   */
  const [widths, setWidths] = useState<number[]>(() =>
    overview.columns.map((c) => fitWidth(c.name, []))
  );
  // 比較をやり直して列が変わったら、幅も付け直す
  useEffect(() => {
    setWidths(overview.columns.map((c) => fitWidth(c.name, [])));
  }, [overview.columns]);

  /** 列の左端 (行番号のぶんだけずらす) */
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = NUM_W;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return out;
  }, [widths]);
  /** 片側ぶんの幅 */
  const total = useMemo(() => widths.reduce((a, b) => a + b, NUM_W), [widths]);

  // 見える行数の計算に使う高さ (左右とも同じ高さなので片方で測る)
  useLayoutEffect(() => {
    const el = leftRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  /*
   * 相手を同じ位置へ動かしている最中か。
   *
   * 動かすと相手側でも onScroll が起きるので、
   * それをそのまま返すと行ったり来たりして止まらなくなる
   */
  const syncing = useRef(false);

  const handleScroll = (side: Side) => (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // 描く行の範囲は、どちらを動かしたときも同じように追いかける
    setScrollTop(el.scrollTop);
    if (syncing.current) return;
    const other = (side === "left" ? rightRef : leftRef).current;
    if (!other) return;
    syncing.current = true;
    if (Math.abs(other.scrollTop - el.scrollTop) >= 1) {
      other.scrollTop = el.scrollTop;
    }
    if (Math.abs(other.scrollLeft - el.scrollLeft) >= 1) {
      other.scrollLeft = el.scrollLeft;
    }
    // 返ってくるぶんを1フレームだけ聞き流す
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visible = Math.ceil(height / ROW_H) + OVERSCAN * 2;
  const last = Math.min(overview.total, first + visible);

  useEffect(() => {
    rows.ensure(first, last);
  }, [rows, first, last]);

  /** その行を画面の真ん中あたりへ持ってくる (左右そろえて動かす) */
  const reveal = useCallback((row: number) => {
    const el = leftRef.current;
    if (!el) return;
    const top = Math.max(0, row * ROW_H - el.clientHeight / 2);
    el.scrollTop = top;
    if (rightRef.current) rightRef.current.scrollTop = top;
  }, []);

  /** 列の幅を変えるドラッグ (見出しの右端のつまみ) */
  const grabColumn = (e: React.MouseEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widths;
    document.body.classList.add("col-resizing");
    const onMove = (m: MouseEvent) =>
      setWidths(
        start.map((v, i) => (i === c ? dragWidth(start[c], m.clientX - startX) : v))
      );
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

  /**
   * 真ん中の仕切りを掴んで、左右の取り分を変える。
   *
   * 変えるのは取り分だけで、列の幅はそのまま
   * (幅まで変わると、見比べている列が動いてしまう)
   */
  const grabSplitter = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = panesRef.current;
    if (!box) return;
    document.body.classList.add("col-resizing");
    const onMove = (m: MouseEvent) => {
      const rect = box.getBoundingClientRect();
      if (rect.width <= 0) return;
      const r = (m.clientX - rect.left) / rect.width;
      setLeftRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)));
    };
    const onUp = () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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

  /** 片側ぶんの表 */
  const pane = (side: Side) => {
    const items = [];
    for (let i = first; i < last; i++) {
      const d = rows.row(i);
      const status = d?.status ?? "same";
      const changed = new Set(d?.changed ?? []);
      const num = side === "left" ? d?.left : d?.right;
      const cells = side === "left" ? d?.leftCells : d?.rightCells;
      items.push(
        <div
          key={i}
          className={`csv-row diff-${status}`}
          style={{ top: i * ROW_H, width: total }}
        >
          <div className="csv-num" style={{ width: NUM_W }}>
            {num !== null && num !== undefined ? num + 1 : ""}
          </div>
          {overview.columns.map((_, c) => (
            <div
              key={c}
              className={"csv-cell" + cellClass(status, side, changed.has(c))}
              style={{ left: lefts[c], width: widths[c] }}
              title={cells?.[c]}
            >
              {cells?.[c] ?? ""}
            </div>
          ))}
        </div>
      );
    }

    return (
      <div
        className="csv-pane"
        // 左側だけ取り分を指定する (右側は残りを埋める)
        style={side === "left" ? { flex: `0 0 ${(leftRatio * 100).toFixed(2)}%` } : undefined}
      >
        <div
          className="csv-grid"
          ref={side === "left" ? leftRef : rightRef}
          onScroll={handleScroll(side)}
        >
          <div className="csv-head" style={{ width: total, height: HEAD_H }}>
            <div className="csv-num head" style={{ width: NUM_W }}>
              #
            </div>
            {overview.columns.map((c, i) => (
              <div
                key={i}
                className="csv-col"
                style={{ left: lefts[i], width: widths[i] }}
                title={`${c.name} (${side === "left" ? "左" : "右"})`}
              >
                <span className="csv-col-name">{c.name}</span>
                <span
                  className="csv-col-grip"
                  title="ドラッグで幅を変えます (ダブルクリックで中身に合わせます)"
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    fitColumn(i);
                  }}
                  onMouseDown={(e) => grabColumn(e, i)}
                />
              </div>
            ))}
          </div>

          <div
            className="csv-body"
            style={{ height: overview.total * ROW_H, width: total }}
          >
            {items}
          </div>
        </div>
      </div>
    );
  };

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

      <div className="csv-panes split" ref={panesRef}>
        {pane("left")}
        <div
          className="csv-splitter"
          title="掴んで動かすと幅を変えられます (ダブルクリックで真ん中に戻します)"
          onMouseDown={grabSplitter}
          onDoubleClick={() => setLeftRatio(0.5)}
        />
        {pane("right")}
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
