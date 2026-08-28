/**
 * SQLエディタ本文の検索。
 *
 * ページ内検索 (FindBar) は画面に出ている文字だけを見るため、
 * CodeMirrorが描いていない画面外の行は見つけられない。
 * エディタ側に「探して選択する」関数を登録してもらい、そちらへ委ねる
 */
export type EditorFinder = (query: string, forward: boolean) => boolean;

let current: EditorFinder | null = null;

/** エディタが自分の検索関数を登録する (アンマウント時はnullで解除) */
export function setEditorFinder(fn: EditorFinder | null): void {
  if (fn === null && current === null) return;
  current = fn;
}

/** 登録されている検索関数 (無ければnull) */
export function editorFinder(): EditorFinder | null {
  return current;
}
