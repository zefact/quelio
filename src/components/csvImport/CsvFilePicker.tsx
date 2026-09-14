import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { fmtBytes } from "../../format";
import { stageDroppedFile } from "../../uploadFile";

/** 取り込む対象のファイル */
export interface PickedFile {
  /** バックエンドへ渡すパス */
  path: string;
  name: string;
  /** D&Dのときだけ分かる (ファイル選択では取得しない) */
  size: number | null;
  /**
   * D&Dで一時フォルダへ預けたファイルか。
   * 預けたものは取り込みが終わるとバックエンドが消す
   */
  staged: boolean;
}

interface Props {
  file: PickedFile | null;
  /** 読み取れた行数 (分かっていれば大きさの隣に出す) */
  rows?: number | null;
  onFile: (f: PickedFile | null) => void;
  onError: (message: string) => void;
  disabled: boolean;
  /** 転送中かどうかを親へ伝える (転送中は取り込みを始めさせない) */
  onBusyChange: (busy: boolean) => void;
}

/** 転送の進み具合 (0〜100)。大きさが分からないときは100として出す */
function percent(p: { done: number; total: number }): number {
  if (p.total <= 0) return 100;
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

/** CSV/TSVファイルの選択 (クリックで選ぶ / ドロップする) */
export function CsvFilePicker({
  file,
  rows = null,
  onFile,
  onError,
  disabled,
  onBusyChange,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  /** D&Dしたファイルの転送の進み具合。転送していなければ null */
  const [staging, setStaging] = useState<{
    /** 送った量と全体 (バイト) */
    done: number;
    total: number;
  } | null>(null);
  /**
   * 転送中かどうか (stateの反映を待たずに見る)。
   * 同じ瞬間に2回ドロップされると、stateでは両方通ってしまう
   */
  const transferring = useRef(false);

  const busy = disabled || staging !== null;

  /** 転送中かどうかを1か所で切り替える (親へ伝えるのを忘れないように) */
  const setTransferring = (
    on: boolean,
    progress: { done: number; total: number } | null
  ) => {
    transferring.current = on;
    setStaging(progress);
    onBusyChange(on);
  };

  /** ファイル選択のダイアログを開いている最中か (Enter連打で2つ開かないように) */
  const picking = useRef(false);

  const pick = async () => {
    if (busy || transferring.current || picking.current) return;
    picking.current = true;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] }],
      });
      if (typeof selected !== "string") return;
      // 区切りはOSによって違うので、両方から末尾を取る
      const name = selected.split(/[\\/]/).pop() ?? selected;
      onFile({ path: selected, name, size: null, staged: false });
    } catch (err) {
      onError(String(err));
    } finally {
      picking.current = false;
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (busy || transferring.current) return;
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setTransferring(true, { done: 0, total: f.size });
    try {
      // ブラウザから見えるFileには実体のパスが無いので、一度預ける
      const path = await stageDroppedFile(f, (done, total) =>
        setStaging({ done, total })
      );
      onFile({ path, name: f.name, size: f.size, staged: true });
    } catch (err) {
      onError(String(err));
    } finally {
      setTransferring(false, null);
    }
  };

  return (
    <div
      className={
        "dropzone" +
        (dragOver ? " over" : "") +
        (file ? " has-file" : "") +
        (busy ? " busy" : "")
      }
      role="button"
      tabIndex={busy ? -1 : 0}
      onClick={pick}
      onKeyDown={(e) => {
        // 中の「×」ボタンのキー操作を横取りしない
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void pick();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {staging !== null ? (
        <>
          <span className="dropzone-file mono">転送中...</span>
          <div className="job-bar dropzone-bar">
            <div
              className="job-bar-fill"
              style={{ width: `${percent(staging)}%` }}
            />
          </div>
          <span className="dropzone-sub mono">
            {percent(staging)}% ({fmtBytes(staging.done)} /{" "}
            {fmtBytes(staging.total)})
          </span>
        </>
      ) : file ? (
        <>
          <span className="dropzone-file mono">{file.name}</span>
          <span className="dropzone-sub mono">
            {[
              file.size !== null ? fmtBytes(file.size) : null,
              rows !== null ? `${rows.toLocaleString()}行` : null,
            ]
              .filter(Boolean)
              .join(" / ")}
          </span>
          {!disabled && (
            <button
              className="dropzone-clear"
              title="選択を解除"
              onClick={(e) => {
                e.stopPropagation();
                onFile(null);
              }}
            >
              ×
            </button>
          )}
        </>
      ) : (
        <>
          <span className="dropzone-main">
            CSV / TSVファイルをここにドロップ
          </span>
          <span className="dropzone-sub">またはクリックして選択</span>
        </>
      )}
    </div>
  );
}
