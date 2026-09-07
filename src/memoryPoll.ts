/**
 * メモリ使用量を数えに行ってよいかの判断。
 *
 * 数えるたびにOSのプロセス一覧を走査するので、
 * 無駄に呼ばない条件をここに集めて、画面から切り離して確かめられるようにする
 */

/** 判断のもとになる、今の状態 */
export interface PollState {
  /** 設定で表示をONにしているか */
  enabled: boolean;
  /** 窓が裏に回っているか (document.hidden) */
  hidden: boolean;
  /** 前の問い合わせがまだ返っていないか */
  asking: boolean;
}

/**
 * 今この瞬間、数えに行ってよいか。
 *
 * - OFFなら行かない (表示しないものを数える意味がない)
 * - 裏に回った窓では行かない (どの窓から聞いても同じ数字が返るため)
 * - 前の問い合わせが返っていなければ行かない (重ねて投げない)
 */
export function shouldAsk({ enabled, hidden, asking }: PollState): boolean {
  return enabled && !hidden && !asking;
}
