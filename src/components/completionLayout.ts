/**
 * 入力補完の候補リストの列幅を揃える。
 *
 * CSSの最小幅だけだと「大きくすると隙間が空き、小さくすると長い行でズレる」ので、
 * 描画されたあとに実際の幅を測って、その回に出ている行に合わせて揃える。
 */

/** 幅を揃える列 (最後の列は後ろに何も続かないので対象外) */
const COLUMNS = ["cm-completionLabel", "ac-table", "ac-logical"];

/** 1つの候補リストの列幅を揃える */
function align(list: HTMLElement) {
  for (const cls of COLUMNS) {
    const cells = list.querySelectorAll<HTMLElement>(`.${cls}`);
    if (cells.length === 0) continue;
    // 前回の指定を外してから測る
    cells.forEach((c) => {
      c.style.width = "auto";
    });
    let max = 0;
    cells.forEach((c) => {
      max = Math.max(max, c.getBoundingClientRect().width);
    });
    cells.forEach((c) => {
      c.style.width = `${Math.ceil(max)}px`;
    });
  }
}

/**
 * 候補リストの置き場所を見張り、中身が変わるたびに列幅を揃える。
 * 幅の指定は style 属性で行うが、属性の変化は監視していないので繰り返しにはならない
 */
export function watchCompletionLayout(host: HTMLElement) {
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      host
        .querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete > ul")
        .forEach(align);
    });
  });
  observer.observe(host, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
