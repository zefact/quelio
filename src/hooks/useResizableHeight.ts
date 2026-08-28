import { useCallback, useRef, useState } from "react";

/** ドラッグを始めるときの指定 */
export interface StartDragOptions {
  /**
   * 開始時の高さ (省略時は今の高さ)。
   * 最大化中など、状態の高さと画面上の高さが違うときに渡す
   */
  from?: number;
  /** 実際に動かし始めたときに1回だけ呼ぶ (押しただけでは呼ばない) */
  onStart?: () => void;
}

/**
 * ドラッグで高さを変えられるペイン用のフック。
 * 返り値: [現在の高さ, スプリッタのonMouseDownに渡すハンドラ]
 */
export function useResizableHeight(
  initial: number,
  min: number,
  max: number
): [number, (e: React.MouseEvent, opts?: StartDragOptions) => void] {
  const [height, setHeight] = useState(initial);
  const heightRef = useRef(height);
  heightRef.current = height;

  const startDrag = useCallback(
    (e: React.MouseEvent, opts?: StartDragOptions) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = opts?.from ?? heightRef.current;
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = "row-resize";
      let moved = false;

      const move = (ev: MouseEvent) => {
        if (!moved) {
          moved = true;
          opts?.onStart?.();
        }
        const next = Math.min(max, Math.max(min, startH + ev.clientY - startY));
        setHeight(next);
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

  return [height, startDrag];
}
