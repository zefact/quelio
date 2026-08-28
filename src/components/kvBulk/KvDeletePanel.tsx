import { useState } from "react";
import { kvCountKeys, kvDeleteKeys } from "../../api";
import { JobProgress } from "../JobProgress";
import { newJobId } from "./jobId";
import type { KvCountResult } from "../../types";

interface Props {
  sessionId: string;
  database: string;
  /** キーブラウザで使っているパターン (初期値) */
  initialPattern: string;
  readOnly: boolean;
  /** 削除が終わったらキー一覧を取り直す */
  onDeleted: () => void;
  /** 実行中かどうかを親へ伝える (閉じさせないため) */
  onBusyChange: (busy: boolean) => void;
}

/**
 * パターンに一致するキーの一括削除。
 *
 * 消す前に必ず数える。件数を見てから「削除」を押す流れにして、
 * パターンの打ち間違いで消し過ぎるのを防ぐ
 */
export function KvDeletePanel({
  sessionId,
  database,
  initialPattern,
  readOnly,
  onDeleted,
  onBusyChange,
}: Props) {
  const [pattern, setPattern] = useState(initialPattern);
  /** 数えた結果 (これが無いうちは削除させない) */
  const [counted, setCounted] = useState<KvCountResult | null>(null);
  /** 数えたときのパターン (変えたら数え直させる) */
  const [countedFor, setCountedFor] = useState<string | null>(null);
  const [job, setJob] = useState<{ id: string; startedAt: number } | null>(
    null
  );
  const [busyKind, setBusyKind] = useState<"count" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const trimmed = pattern.trim();
  const stale = countedFor !== trimmed;
  /*
   * `*` だけでなく `**` `?*` も実質すべてのキーに当たる。
   * バックエンドと同じ見方をして、確認の表示と受け渡しを揃える
   */
  const isAll =
    trimmed.length > 0 && [...trimmed].every((c) => c === "*" || c === "?");
  /*
   * 数え終えているか。
   * 上限に達して打ち切ったとき (truncated) は件数が控えめに出るだけなので、
   * 表示で断ったうえで削除は認める。
   * 途中で止めたとき (cancelled) は数え直させる
   */
  const trusted = !!counted && !counted.cancelled;

  const start = (kind: "count" | "delete") => {
    const started = { id: newJobId("kvbulk"), startedAt: Date.now() };
    setJob(started);
    setBusyKind(kind);
    setError(null);
    onBusyChange(true);
    return started;
  };

  const finish = () => {
    setJob(null);
    setBusyKind(null);
    onBusyChange(false);
  };

  const count = async () => {
    if (!trimmed || busyKind) return;
    const started = start("count");
    setResult(null);
    try {
      const r = await kvCountKeys(sessionId, database, trimmed, started.id);
      setCounted(r);
      setCountedFor(trimmed);
    } catch (e) {
      setCounted(null);
      setCountedFor(null);
      setError(String(e));
    } finally {
      finish();
    }
  };

  const remove = async () => {
    if (!trusted || stale || busyKind || readOnly) return;
    const started = start("delete");
    setResult(null);
    try {
      const r = await kvDeleteKeys(
        sessionId,
        database,
        trimmed,
        isAll,
        started.id
      );
      setResult(
        r.cancelled
          ? `中止しました (${r.deleted.toLocaleString()}件を削除済み)`
          : `${r.deleted.toLocaleString()}件を削除しました` +
              (r.truncated ? " (上限に達したため途中で止めました)" : "")
      );
      // 消したぶん件数が変わるので、数え直させる
      setCounted(null);
      setCountedFor(null);
      onDeleted();
    } catch (e) {
      /*
       * 途中まで消えていることがあるので、件数は必ず数え直させる
       * (古い件数のまま、もう一度「削除」を押せてしまわないように)
       */
      setCounted(null);
      setCountedFor(null);
      onDeleted();
      setError(String(e));
    } finally {
      finish();
    }
  };

  return (
    <div className="kv-bulk-panel">
      <div className="db-admin-row">
        <input
          className="text-field mono db-admin-name"
          value={pattern}
          spellCheck={false}
          disabled={!!busyKind}
          placeholder="パターン (例: cache:*)"
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") void count();
          }}
        />
        <button
          className="btn-secondary"
          disabled={!trimmed || !!busyKind}
          onClick={count}
        >
          数える
        </button>
        <button
          className="btn-danger"
          disabled={readOnly || !trusted || stale || !!busyKind}
          title={
            readOnly
              ? "読み取り専用の接続では削除できません"
              : stale
                ? "パターンを変えたら、もう一度数えてください"
                : !trusted
                  ? "数えるのを中止しました。もう一度数えてください"
                  : undefined
          }
          onClick={remove}
        >
          削除
        </button>
      </div>

      {job && (
        <JobProgress
          jobId={job.id}
          startedAt={job.startedAt}
          verb={busyKind === "delete" ? "削除" : "確認"}
          unit="件"
          onError={setError}
        />
      )}

      {counted && !stale && (
        <div
          className={
            counted.total === 0 ? "result-banner" : "result-banner warn"
          }
        >
          <span className="dot" aria-hidden />
          <span className="result-detail">
            {counted.total === 0
              ? "一致するキーはありません"
              : `${counted.total.toLocaleString()}件が対象です` +
                (counted.truncated ? " (上限まで数えた時点の件数です)" : "") +
                (counted.cancelled ? " (数えるのを中止しました)" : "")}
            {isAll &&
              counted.total > 0 &&
              " — このDBのキーがほぼすべて消えます"}
          </span>
        </div>
      )}

      {counted && !stale && counted.sample.length > 0 && (
        <ul className="kv-bulk-sample mono">
          {counted.sample.map((k) => (
            <li key={k}>{k}</li>
          ))}
          {counted.total > counted.sample.length && (
            <li className="faint">
              ほか {(counted.total - counted.sample.length).toLocaleString()} 件
            </li>
          )}
        </ul>
      )}

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <span className="result-detail">{error}</span>
        </div>
      )}
      {result && (
        <div className="result-banner ok">
          <span className="dot" aria-hidden />
          <span className="result-detail">{result}</span>
        </div>
      )}

      <p className="db-admin-hint">
        削除は取り消せません。UNLINKで消すので、消し終わるまでの間も他の操作は止まりません。
        <br />
        数えている間・消している間にキーが増減すると、1回では取りきれないことがあります
        (もう一度実行すると残りが消えます)。
      </p>
    </div>
  );
}
