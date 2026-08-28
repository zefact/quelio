import { useEffect, useState } from "react";
import { csvExportStatus } from "../api";
import type { JobPhase } from "../types";

interface Props {
  /** 実行中のCSV出力ジョブID */
  jobId: string;
  /** 出力を開始した時刻 (ms) */
  startedAt: number;
  /** 表示する動作の名前 (CSV取り込みなどでも使うため差し替えられる) */
  verb?: string;
  /** 数えているものの単位 (行 / 件 / テーブル) */
  unit?: string;
}

/** 更新間隔 (ms) */
const TICK_MS = 300;

/**
 * 局面ごとの言葉。
 *
 * 確定と取り消しの間は件数が動かないので、そのまま「取り込み中」と
 * 出し続けると固まったように見える。とくにMySQLの巻き戻しは
 * 取り込み本体より時間がかかることがある
 */
const PHASE_LABEL: Record<Exclude<JobPhase, "working">, string> = {
  committing: "確定中",
  rollingBack: "取り消し中",
};

const PHASE_TIP: Record<Exclude<JobPhase, "working">, string> = {
  committing: "サーバーが変更を確定しています。件数が多いと時間がかかります。",
  rollingBack:
    "サーバーが変更を巻き戻しています。件数が多いと取り込みより長くかかることがあります。",
};

/**
 * CSV出力の進捗 (書き出し済み行数と経過時間) の表示。
 * 定期更新をこのコンポーネントの中だけに閉じ込める
 * (親に置くと、0.3秒ごとに結果グリッドまで作り直しになる)
 */
export function CsvProgress({
  jobId,
  startedAt,
  verb = "出力",
  unit = "行",
}: Props) {
  const [state, setState] = useState<{
    rows: number;
    elapsed: number;
    phase: JobPhase;
  }>({ rows: 0, elapsed: 0, phase: "working" });

  // 経過時間と処理済み件数を1本のタイマーでまとめて更新する
  useEffect(() => {
    let alive = true;
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      setState((cur) => ({ ...cur, elapsed }));
      csvExportStatus(jobId)
        .then((p) => {
          if (!alive || !p) return;
          setState((cur) =>
            cur.rows === p.rows && cur.phase === p.phase
              ? cur
              : { ...cur, rows: p.rows, phase: p.phase }
          );
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [jobId, startedAt]);

  const busy = state.phase === "working" ? null : state.phase;

  return (
    <span
      className="capture-msg mono csv-progress"
      role="status"
      aria-live="polite"
      title={busy ? PHASE_TIP[busy] : undefined}
    >
      {state.rows.toLocaleString()}
      {unit} {busy ? PHASE_LABEL[busy] : `${verb}中`}... (
      {(state.elapsed / 1000).toFixed(1)}s)
    </span>
  );
}
