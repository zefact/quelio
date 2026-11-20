import { useEffect, useRef, useState } from "react";
import { revealPath } from "../api";

interface Props {
  /** 書き出したファイルのフルパス */
  path: string;
}

/**
 * 書き出したファイルの場所をOSのファイラ (Finder / エクスプローラー) で開くボタン。
 * 書き出しが終わったら、どの画面でもこれを出す (知らせは閉じるまで残す)
 */
export function RevealButton({ path }: Props) {
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  // 別のファイルに変わったら前の失敗表示は消す
  useEffect(() => {
    setError(null);
  }, [path]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  /** 失敗表示は数秒で元に戻す (押し直せると分かるように) */
  const fail = (message: string) => {
    setError(message);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setError(null), 4000);
  };

  return (
    <button
      className={
        "reveal-btn has-tooltip tooltip-left tooltip-wide" + (error ? " reveal-error" : "")
      }
      data-tooltip={error ?? `フォルダを開く\n${path}`}
      aria-label="フォルダを開く (書き出したファイルの場所)"
      onClick={() => {
        setError(null);
        revealPath(path).catch((e) => fail(`開けませんでした: ${e}`));
      }}
    >
      {error ? "開けませんでした" : "フォルダを開く"}
    </button>
  );
}
