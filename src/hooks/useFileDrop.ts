import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * ウィンドウにファイルを落とせるようにする。
 *
 * OSからの落とし込みはWebView標準の drop イベントには来ないので、
 * Tauriの `tauri://drag-drop` を受ける。
 * 「今カーソルが乗っているか」も返すので、画面側で目印を出せる
 */
export function useFileDrop(
  /** 落とされたファイルのパス (複数のこともある) */
  onDrop: (paths: string[]) => void
): boolean {
  const [over, setOver] = useState(false);

  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setOver(true);
      else if (p.type === "leave") setOver(false);
      else if (p.type === "drop") {
        setOver(false);
        if (p.paths.length > 0) onDrop(p.paths);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [onDrop]);

  return over;
}
