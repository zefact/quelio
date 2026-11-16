/**
 * 書き出し・流し込みの残り時間の見積もり。
 *
 * 進み具合 (0〜1) の記録から、最近の速さで残りを割る。
 * 速さはテーブルごと・文ごとに揺れるので、直近の一定時間の平均を使う。
 * 直近で進んでいない (大きなインデックスを作っている最中など) ときは、
 * 始めからの平均に切り替える
 */

/** 1回の観測 (時刻はミリ秒) */
export interface EtaSample {
  at: number;
  progress: number;
}

/** 速さを測る範囲 */
const WINDOW_MS = 2 * 60 * 1000;
/** これより前は見積もらない (始めは速さがぶれる) */
const MIN_ELAPSED_MS = 5 * 1000;
const MIN_PROGRESS = 0.005;

/** 観測を足す (古すぎるものは捨てる。始めの1つは平均のために残す) */
export function pushSample(samples: EtaSample[], s: EtaSample): EtaSample[] {
  const first = samples[0];
  const recent = samples.filter((x) => s.at - x.at <= WINDOW_MS);
  const next = [...recent, s];
  return first && first !== recent[0] ? [first, ...next] : next;
}

/** 残りの秒数 (見積もれなければ null) */
export function remainingSeconds(samples: EtaSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (last.at - first.at < MIN_ELAPSED_MS || last.progress < MIN_PROGRESS) {
    return null;
  }
  if (last.progress >= 1) return 0;
  const left = 1 - last.progress;
  // 直近の速さ
  const from = samples.find((x) => last.at - x.at <= WINDOW_MS && x !== last);
  if (from && last.progress > from.progress) {
    const rate = (last.progress - from.progress) / (last.at - from.at);
    return Math.round(left / rate / 1000);
  }
  // 始めからの平均
  const rate = (last.progress - first.progress) / (last.at - first.at);
  return rate > 0 ? Math.round(left / rate / 1000) : null;
}

/** 「1時間5分」「3分20秒」「45秒」の形 */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}時間${m}分` : `${h}時間`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r > 0 ? `${m}分${r}秒` : `${m}分`;
  }
  return `${s}秒`;
}

/** 残りの目安 (大まかな数字に丸める。秒まで出すと揺れて読みにくい) */
export function fmtRemaining(sec: number): string {
  if (sec < 60) return "1分以内";
  if (sec < 3600) return `約${Math.ceil(sec / 60)}分`;
  const h = Math.floor(sec / 3600);
  const m = Math.ceil((sec % 3600) / 60 / 5) * 5;
  if (m >= 60) return `約${h + 1}時間`;
  return m > 0 ? `約${h}時間${m}分` : `約${h}時間`;
}
