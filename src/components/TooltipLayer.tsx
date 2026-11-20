/**
 * ツールチップ (操作の説明) を描く層。各ウィンドウのルートに1つだけ置く。
 *
 * `has-tooltip` の class と `data-tooltip` を持つ要素にマウスを乗せる
 * (またはキーボードで移る) と、その説明を画面の一番上に出す。
 *
 * 前は CSS の ::after でボタンの中に描いていたが、それだと
 *  - スクロールする一覧・メニュー・ダイアログの中では、枠の外が切れて読めない
 *  - 押せないボタンを薄くすると (opacity)、説明まで一緒に透ける
 *  - 入力欄 (input) には ::after を描けない
 * という弱点があり、そういう所では説明に title を使うしかなかった。
 * ここで body の直下に描けば、どこに置いた要素でも同じように出せる。
 *
 * 決まり:
 *  - 乗せてから 0.35 秒待って出す。Tab で移ってきたときはすぐ出す
 *  - クリックしたら消す (押したあとも出ていると、開いたメニューに重なる)
 *  - 窓が裏に回ったら消す
 *  - 既定は対象の右端にそろえる。`tooltip-left` なら左端にそろえる
 *  - `tooltip-wide` は長いパスなどのために幅を広げる
 *
 * 押せないボタンは、マウスのイベントを出さないことがある。
 * そのため「いまマウスが乗っている要素」はイベントではなく :hover で調べる
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "../tooltipPlace";

/** 説明を出す要素 */
const TARGET = ".has-tooltip[data-tooltip]";
/** マウスが乗ってから出すまで */
const SHOW_DELAY = 350;
/** :hover を調べる間隔 */
const POLL = 100;

interface Shown {
  el: HTMLElement;
  text: string;
}

/** いまマウスが乗っている説明つきの要素 (入れ子なら一番内側) */
function hoveredTarget(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`${TARGET}:hover`);
  return all.length > 0 ? all[all.length - 1] : null;
}

function tipText(el: HTMLElement): string {
  return el.getAttribute("data-tooltip")?.trim() ?? "";
}

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    /** マウスで乗せている要素 (待っている間も含む) */
    let hovering: HTMLElement | null = null;
    /** キーボードで移ってきて出している要素 */
    let focused: HTMLElement | null = null;
    /** クリックして消した要素 (離れるまでは出し直さない) */
    let dismissed: HTMLElement | null = null;
    let timer: number | null = null;
    /**
     * 直前に Tab で移ってきたか。
     * 入力欄はマウスで押しても :focus-visible になるので、それでは見分けられない。
     * 押したときや、開いた画面が自動で入力欄にフォーカスしたときは出さない
     */
    let byTab = false;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const show = (el: HTMLElement) => {
      const text = tipText(el);
      setShown(text ? { el, text } : null);
    };
    const hide = () => {
      clearTimer();
      setShown(null);
    };

    const poll = () => {
      if (!document.hasFocus()) {
        if (hovering) {
          hovering = null;
          hide();
        }
        return;
      }
      const el = hoveredTarget();
      if (el !== dismissed) dismissed = null;
      if (el === hovering) {
        // 乗せたまま説明だけ変わった (押せる/押せないの切り替えなど)
        if (el && timer === null && el !== dismissed) show(el);
        return;
      }
      hovering = el;
      clearTimer();
      if (!el || el === dismissed) {
        if (focused) show(focused);
        else setShown(null);
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        show(el);
      }, SHOW_DELAY);
    };
    const interval = window.setInterval(poll, POLL);

    const onFocusIn = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(TARGET);
      if (!el) return;
      // マウスで押したときのフォーカスでは出さない (Tab で移ったときだけ)
      if (!byTab) return;
      focused = el;
      clearTimer();
      show(el);
    };
    const onFocusOut = () => {
      if (!focused) return;
      focused = null;
      if (!hovering) hide();
    };
    const onPointerDown = () => {
      byTab = false;
      dismissed = hovering ?? focused;
      focused = null;
      hide();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      byTab = e.key === "Tab";
      if (e.key === "Escape") {
        dismissed = hovering ?? focused;
        hide();
      }
    };
    // スクロールしたら対象が動くので、いったん消す
    const onScroll = () => {
      dismissed = hovering;
      hide();
    };
    const onBlur = () => {
      hovering = null;
      focused = null;
      hide();
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearInterval(interval);
      clearTimer();
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // 対象が画面から消えたら説明も消す
  useEffect(() => {
    if (!shown) return;
    const check = window.setInterval(() => {
      if (!shown.el.isConnected) setShown(null);
    }, POLL);
    return () => window.clearInterval(check);
  }, [shown]);

  // 大きさを測ってから置く (それまでは見えない所に描く)
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!shown || !tip) {
      setPos(null);
      return;
    }
    const r = shown.el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    setPos(
      placeTooltip(
        r,
        { width: t.width, height: t.height },
        { width: window.innerWidth, height: window.innerHeight },
        shown.el.classList.contains("tooltip-left") ? "left" : "right",
      ),
    );
  }, [shown]);

  if (!shown) return null;
  const wide = shown.el.classList.contains("tooltip-wide");
  return createPortal(
    <div
      ref={tipRef}
      className={"tooltip-pop" + (wide ? " wide" : "") + (pos ? " placed" : "")}
      style={pos ?? { left: 0, top: 0 }}
      role="tooltip"
    >
      {shown.text}
    </div>,
    document.body,
  );
}
