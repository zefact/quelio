import { useState } from "react";
import { cancelCsvExport } from "../api";
import { CsvProgress } from "./CsvProgress";

interface Props {
  jobId: string;
  startedAt: number;
  /** 表示する動作の名前 (削除 / 走査 など) */
  verb: string;
  /** 数えているものの単位 (件 / テーブル など) */
  unit: string;
  /** 中止を頼めなかったときに知らせる */
  onError: (message: string) => void;
}

/**
 * 時間のかかる処理の進捗と中止ボタン。
 *
 * 中止は「頼んだ」ことが分かるように、押したら表示を変えて押せなくする
 * (実際に止まるのは、処理側が区切りに来たとき)
 */
export function JobProgress({
  jobId,
  startedAt,
  verb,
  unit,
  onError,
}: Props) {
  const [asked, setAsked] = useState(false);

  return (
    <div className="kv-bulk-progress">
      <CsvProgress
        jobId={jobId}
        startedAt={startedAt}
        verb={verb}
        unit={unit}
      />
      <button
        className="btn-secondary"
        disabled={asked}
        onClick={() => {
          setAsked(true);
          cancelCsvExport(jobId).catch((e) => {
            setAsked(false);
            onError(`中止できませんでした: ${e}`);
          });
        }}
      >
        {asked ? "中止しています..." : "中止"}
      </button>
    </div>
  );
}
