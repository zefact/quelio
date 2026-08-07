import { useCallback, useRef, useState } from "react";

/**
 * ドラッグで高さを変えられるペイン用のフック。
 * 返り値: [現在の高さ, スプリッタのonMouseDownに渡すハンドラ]
 */
export function useResizableHeight(
  initial: number,
  min: number,
  max: number
): [number, (e: React.MouseEvent) => void] {
  const [height, setHeight] = useState(initial);
  const heightRef = useRef(height);
  heightRef.current = height;

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = heightRef.current;
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = "row-resize";

      const move = (ev: MouseEvent) => {
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
