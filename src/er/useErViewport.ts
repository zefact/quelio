/**
 * ER図の「見え方」(位置と拡大率) の扱い。
 *
 * パン・ズーム・全体表示・座標の変換は、図の中身とは関係なく、
 * どれも同じ view を触るだけ。
 * ErWindow に混ぜて置くと、選択や編集の処理と読み分けにくいので分けている
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rafThrottle } from "../rafThrottle";

/** 表示変換 (図をどこに、どの大きさで出すか) */
export interface ErView {
  x: number;
  y: number;
  scale: number;
}

/** 拡大率の下限・上限 (これ以上は文字が読めない / 意味がない) */
const MIN_SCALE = 0.12;
const MAX_SCALE = 2.5;

export interface ErViewport {
  view: ErView;
  /**
   * ドラッグ中に見る最新の表示。
   *
   * ドラッグの処理は document に付けるので、view を直接見ると
   * 掴んだ時点の拡大率で固定され、途中でズームすると動きがずれる
   */
  viewRef: React.RefObject<ErView>;
  /** キャンバス (この要素の中で図を動かす) */
  canvasRef: React.RefObject<HTMLDivElement | null>;
  /** 画面の座標を図の座標へ直す */
  toWorld: (clientX: number, clientY: number) => { x: number; y: number };
  /** キャンバス中央を基準に拡大・縮小する */
  zoomBy: (factor: number) => void;
  /** 図全体 (右下が maxX, maxY) が収まるように合わせる */
  fitTo: (maxX: number, maxY: number) => void;
  /** 背景ドラッグでの移動 (押した位置からの差分で動かす) */
  startPan: (e: React.MouseEvent) => void;
  /** 指定のぶんだけ動かす (検索の一致位置を中央に出すときなど) */
  panBy: (dx: number, dy: number) => void;
  /**
   * ホイール操作を受け付ける。
   *
   * passive でないリスナが要るので、要素へ直接付ける。
   * キャンバスは読み込みが終わるまでDOMに無いため、
   * 表示状態が変わるたびに付け直す (その合図が deps)
   */
  useWheel: (deps: unknown[]) => void;
}

export function useErViewport(initial?: Partial<ErView>): ErViewport {
  const [view, setView] = useState<ErView>({
    x: initial?.x ?? 40,
    y: initial?.y ?? 20,
    scale: initial?.scale ?? 0.8,
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const canvasRef = useRef<HTMLDivElement>(null);

  /*
   * どれも ref と setView しか見ないので、関数の同一性は変えない。
   * 呼び出し側が効果の依存に入れても、そのたびに付け直しにならない
   */
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - (rect?.left ?? 0) - v.x) / v.scale,
      y: (clientY - (rect?.top ?? 0) - v.y) / v.scale,
    };
  }, []);

  /** ある点 (キャンバス内の座標) を動かさずに拡大率を変える */
  const zoomAt = useCallback((factor: number, mx: number, my: number) => {
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      return {
        scale,
        x: mx - ((mx - v.x) * scale) / v.scale,
        y: my - ((my - v.y) * scale) / v.scale,
      };
    });
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      zoomAt(factor, rect.width / 2, rect.height / 2);
    },
    [zoomAt]
  );

  const fitTo = useCallback((maxX: number, maxY: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 余白 (40px) を残して収める。広げすぎない (等倍が上限)
    const scale = Math.min(
      1,
      (rect.width - 40) / (maxX + 40),
      (rect.height - 40) / (maxY + 40)
    );
    setView({ x: 20, y: 20, scale: Math.max(MIN_SCALE, scale) });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }, []);

  const startPan = useCallback((e: React.MouseEvent) => {
    const start = { x: e.clientX, y: e.clientY };
    const orig = { ...viewRef.current };
    // 表示位置の更新は1フレーム1回に間引く (図の全ノードを描き直すため)
    const apply = rafThrottle<[number, number]>(([x, y]) =>
      setView({ ...orig, x: orig.x + x, y: orig.y + y })
    );
    let moved = false;
    const move = (ev: MouseEvent) => {
      moved = true;
      apply.run([ev.clientX - start.x, ev.clientY - start.y]);
    };
    const up = (ev: MouseEvent) => {
      apply.cancel();
      document.removeEventListener("mousemove", move);
      // 動かしていなければ何もしない (押しただけで再描画しない)
      if (!moved) return;
      // 間引きで取りこぼした最後の位置をここで確定させる
      setView({
        ...orig,
        x: orig.x + (ev.clientX - start.x),
        y: orig.y + (ev.clientY - start.y),
      });
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  }, []);

  const useWheel = (deps: unknown[]) => {
    useEffect(() => {
      const el = canvasRef.current;
      if (!el) return;
      /*
       * パンは1フレームに1回だけ反映する。
       * トラックパッドのwheelは細かく大量に届くので、そのたびに
       * 表示位置を更新すると図の全ノードを描き直すことになる
       */
      const pan = { x: 0, y: 0 };
      const applyPan = rafThrottle<void>(() => {
        const dx = pan.x;
        const dy = pan.y;
        pan.x = 0;
        pan.y = 0;
        if (dx === 0 && dy === 0) return;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      });
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        // ピンチ (ctrlKey付きwheel) / ⌘・Ctrl+スクロール = ズーム、通常 = パン
        if (e.ctrlKey || e.metaKey) {
          const rect = el.getBoundingClientRect();
          zoomAt(
            Math.exp(-e.deltaY * 0.01),
            e.clientX - rect.left,
            e.clientY - rect.top
          );
        } else {
          pan.x += e.deltaX;
          pan.y += e.deltaY;
          applyPan.run(undefined);
        }
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => {
        applyPan.cancel();
        el.removeEventListener("wheel", onWheel);
      };
      // 呼び出し側が「付け直す合図」を渡す
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
  };

  return {
    view,
    viewRef,
    canvasRef,
    toWorld,
    zoomBy,
    fitTo,
    startPan,
    panBy,
    useWheel,
  };
}
