import { useCallback, useRef, useState } from "react";

/**
 * ドラッグで横幅を変えられるペイン用のフック。
 * 返り値: [現在の幅, スプリッタのonMouseDownに渡すハンドラ, 幅を足し引きする関数]
 *
 * 3つ目はキーボード (矢印キー) で幅を変えるときに使う
 */
export function useResizableWidth(
  initial: number,
  min: number,
  max: number
): [number, (e: React.MouseEvent) => void, (delta: number) => void] {
  const [width, setWidth] = useState(initial);
  const widthRef = useRef(width);
  widthRef.current = width;

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = "col-resize";

      const move = (ev: MouseEvent) => {
        const next = Math.min(max, Math.max(min, startW + ev.clientX - startX));
        setWidth(next);
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.body.style.cursor = prevCursor;
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up, { once: true });
    },
    [min, max]
  );

  /** 幅を delta だけ変える (上限・下限の中に収める) */
  const nudge = useCallback(
    (delta: number) =>
      setWidth((w) => Math.min(max, Math.max(min, w + delta))),
    [min, max]
  );

  return [width, startDrag, nudge];
}
