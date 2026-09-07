/**
 * アプリ全体のメモリ使用量。
 *
 * 大きなCSVや結果セットを開いたときに、どれだけ抱えているかを
 * その場で見られるようにするためのもの。
 * 常時数えると僅かとはいえ負担がかかるので、設定 > 一般 > 外観 でONにしたときだけ出す。
 * 数えている範囲がOSによって違うので、説明はツールチップに置く
 */
import { fmtBytes } from "../format";
import { useAppMemory } from "../hooks/useAppMemory";
import { useWatchedSettings } from "../hooks/useWatchedSettings";

/** macOSかどうか (数えられる範囲の説明を変える) */
const IS_MAC = navigator.userAgent.includes("Mac");

export function MemoryChip() {
  const { showMemory } = useWatchedSettings();
  const memory = useAppMemory(showMemory);
  if (!showMemory || !memory) return null;

  const detail = [
    `本体 ${fmtBytes(memory.own)}`,
    memory.processes > 1
      ? `ほか${memory.processes - 1}プロセス ${fmtBytes(memory.bytes - memory.own)}`
      : null,
    IS_MAC
      ? "macOSでは画面を描くプロセスがOSの下にぶら下がるため、この合計には入りません"
      : null,
    "OSが実際に割り当てているメモリ (RSS) です",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span className="status-memory mono" title={detail}>
      メモリ {fmtBytes(memory.bytes)}
    </span>
  );
}
