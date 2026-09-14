/**
 * タブをドラッグで並べ替える。
 *
 * DBの接続タブ・ER図のタブ・CSVのタブで、まったく同じ動きをさせたい。
 *
 * 掴んだタブは指についてきて、まわりのタブは場所を空けるように横へ滑る。
 * 並びそのものを書き換えるのは手を離したとき1回だけ
 * (動かしている最中に並びを差し替えると、掴んだタブが指から外れてしまう)。
 * HTML5 の drag&drop は Tauri の窓ドラッグと当たるので使わない
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { rafThrottle } from "../rafThrottle";
import { dropIndex, slideOf, type TabRect } from "../tabSlide";
import { useEvent } from "./useEvent";

/**
 * ここまでは「ただのクリック」とみなす幅 (px)。
 *
 * 押した指がわずかに震えただけでタブが動くと、
 * 切り替えたつもりが動いてしまう
 */
const SLACK = 3;

/** タブを探す目印 (並んでいる兄弟だけを測るために付ける) */
export const TAB_MARK = "data-tab-index";

/** ドラッグ中に覚えておくもの */
interface Drag {
  /** 掴んだタブの位置 */
  from: number;
  /** 今どこへ落ちるか */
  to: number;
  /** 押した所からどれだけ動いたか (px) */
  dx: number;
  /** 掴む前に測った、それぞれのタブの位置 */
  rects: TabRect[];
}

export interface TabReorder {
  /** タブを掴む (そのタブの onMouseDown で渡す) */
  start: (index: number, e: React.MouseEvent<HTMLElement>) => void;
  /** そのタブに付ける見た目 (動いていないときは undefined) */
  styleOf: (index: number) => CSSProperties | undefined;
  /** 掴んでいるタブの、もとの位置 (掴んでいなければ null) */
  dragging: number | null;
}

export interface TabReorderOptions {
  /** 並びを入れ替える (手を離したときに1回だけ呼ばれる) */
  onMove: (from: number, to: number) => void;
  /** 並べ替えが終わったとき (保存の合図)。動かしたときだけ呼ぶ */
  onEnd?: () => void;
}

/** 並んでいるタブの位置をまとめて測る */
function measure(el: HTMLElement): TabRect[] {
  const parent = el.parentElement;
  if (!parent) return [];
  return [...parent.querySelectorAll<HTMLElement>(`:scope > [${TAB_MARK}]`)].map(
    (t) => {
      const r = t.getBoundingClientRect();
      return { left: r.left, width: r.width };
    }
  );
}

export function useTabReorder({
  onMove,
  onEnd,
}: TabReorderOptions): TabReorder {
  const [drag, setDrag] = useState<Drag | null>(null);
  /** 動かしている間の最新の状態 (documentのイベントから見る) */
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  /** 押した位置 (ここからの差で動かす) */
  const pressX = useRef(0);
  /** 一度でも動かしたか (押しただけなら並べ替えない) */
  const moved = useRef(false);

  const start = useEvent((index: number, e: React.MouseEvent<HTMLElement>) => {
    // 掴むのは左ボタンだけ (右クリックはメニュー)
    if (e.button !== 0) return;
    const rects = measure(e.currentTarget);
    if (rects.length < 2) return;
    pressX.current = e.clientX;
    moved.current = false;
    setDrag({ from: index, to: index, dx: 0, rects });
  });

  /*
   * 動かしている間の更新。
   *
   * mousemoveは1フレームに何度も飛んでくるので、
   * 描き直しは1フレーム1回に間引く
   */
  const move = useEvent((clientX: number) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = clientX - pressX.current;
    // 指が震えただけの間は、まだ動かし始めない
    if (!moved.current && Math.abs(dx) < SLACK) return;
    moved.current = true;
    setDrag({ ...d, dx, to: dropIndex(d.rects, d.from, dx) });
  });

  const finish = useEvent(() => {
    const d = dragRef.current;
    if (!d) return;
    const didMove = moved.current;
    moved.current = false;
    setDrag(null);
    // 押しただけ (動かしていない) なら、並べ替えでもなければ保存でもない
    if (!didMove) return;
    if (d.to !== d.from) onMove(d.from, d.to);
    onEnd?.();
  });

  const active = drag !== null;
  useEffect(() => {
    if (!active) return;
    // 掴んでいる間だけ、documentで指の動きを受ける
    // (タブの外まで動かしても追いかけられるように)
    const throttled = rafThrottle<number>(move);
    const onMouseMove = (e: MouseEvent) => throttled.run(e.clientX);
    const onMouseUp = () => {
      throttled.cancel();
      finish();
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      throttled.cancel();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    // 中身ではなく「掴んでいるか」だけで付け外しする
    // (指を動かすたびに付け直すと、動きが途切れてしまう)
  }, [active, move, finish]);

  /*
   * そのタブをどう描くか。
   *
   * 描いている最中に呼ぶので useEvent には包まない (常に今の状態を見る)
   */
  const styleOf = (index: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    const x = slideOf(drag.rects, drag.from, drag.to, drag.dx, index);
    if (index === drag.from) {
      return {
        transform: `translateX(${x}px)`,
        // 掴んでいるタブは指について動くので、遅れて追う動きは要らない
        transition: "none",
        position: "relative",
        zIndex: 3,
      };
    }
    // まわりのタブは、CSS側の transition でなめらかに滑る
    return x === 0 ? undefined : { transform: `translateX(${x}px)` };
  };

  return { start, styleOf, dragging: drag?.from ?? null };
}
