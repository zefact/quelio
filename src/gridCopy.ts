/** グリッドの行をタブ区切りテキストにしてクリップボードへ渡すための処理 */

/** 行要素(<tr>)の並びから、指定した列だけをタブ区切りテキストにする */
export function rowsToTsv(rows: HTMLElement[], colIndexes: number[]): string {
  return rows
    .map((tr) => {
      const cells = Array.from(tr.children) as HTMLElement[];
      return colIndexes.map((i) => cells[i]?.textContent ?? "").join("\t");
    })
    .join("\n");
}

/**
 * クリップボードへ書き込む。
 * navigator.clipboardが使えない環境では隠しテキストエリア経由でコピーする
 */
export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 使えない場合は下のフォールバックへ */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0;";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("コピーできませんでした");
    }
  } finally {
    ta.remove();
  }
}
