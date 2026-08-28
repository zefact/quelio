import { CSSProperties, RefObject, useLayoutEffect, useRef, useState } from "react";

/** 画面の端から最低限空ける余白 */
const MARGIN = 8;

/**
 * 右クリックメニューやポップアップを、画面からはみ出さない位置に置くためのフック。
 *
 * 指定した座標を左上として出し、
 *  - 右にはみ出すときは左側へ折り返す (それでも入らなければ画面内へ押し戻す)
 *  - 下にはみ出すときは上側へ折り返す (同上)
 *  - 画面の高さに収まらないときはスクロールさせる
 * 返り値の ref を対象要素に、style をそのまま style に渡す。
 *
 * flipY は「上へ折り返すときに下端として使う座標」。
 * ボタンの下に出すメニューでは、そのボタンの上端を渡すと重ならずに折り返せる
 */
export function usePopupPosition<T extends HTMLElement>(
  x: number,
  y: number,
  flipY?: number
): [RefObject<T | null>, CSSProperties] {
  const ref = useRef<T>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: x, top: y });
  /**
   * CSSで指定された max-height。
   *
   * ここで付けるインラインの max-height はCSSの指定より強いので、
   * 覚えておかないと「CSSでは320pxまで」のメニューを
   * 画面の高さまで伸ばしてしまう。
   * インラインを付ける前 (最初に開いたとき) の値だけを覚える
   */
  const cssMax = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (cssMax.current === null) {
      const raw = getComputedStyle(el).maxHeight;
      cssMax.current = raw.endsWith("px")
        ? Number.parseFloat(raw)
        : Number.POSITIVE_INFINITY;
    }

    const place = () => {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 画面に収まる高さと、CSSの指定のうち小さいほうまでに収める
      const maxH = Math.min(vh - MARGIN * 2, cssMax.current ?? Infinity);
      // 表示上の高さ (CSSのmax-heightが効いていればその値) で位置を決める
      const h = Math.min(rect.height, maxH);
      // 中身が入りきるかはscrollHeightで見る (付けたmax-heightに影響されない)
      const tooTall = el.scrollHeight > maxH + 1;

      let left = x;
      if (left + rect.width > vw - MARGIN) {
        // 右で切れる: まずカーソルの左側へ、それでも無理なら画面内へ寄せる
        left = x - rect.width;
        if (left < MARGIN) left = Math.max(MARGIN, vw - MARGIN - rect.width);
      }

      let top = y;
      if (top + h > vh - MARGIN) {
        top = (flipY ?? y) - h;
        if (top < MARGIN) top = Math.max(MARGIN, vh - MARGIN - h);
      }

      const next: CSSProperties = tooTall
        ? { left, top, maxHeight: maxH, overflowY: "auto" }
        : { left, top };
      setStyle((prev) =>
        prev.left === next.left &&
        prev.top === next.top &&
        prev.maxHeight === next.maxHeight
          ? prev
          : next
      );
    };

    place();
    // 中身があとから増えるメニュー (履歴・保存など) にも追従する
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
    // 位置が変わったとき (開き直したとき) だけ計算し直す
  }, [x, y, flipY]);

  return [ref, style];
}
