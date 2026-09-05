/**
 * 「後から始めたものを優先し、古い応答は捨てる」ための番号札。
 *
 * 応答を待っている間に、利用者が取り消したり、別の操作を始めたりする。
 * 遅れて返ってきた古い応答をそのまま画面へ当てると、
 * 閉じたはずの画面が開き直ったり、消したはずの結果が戻ったりする。
 *
 * 始めるときに番号を取り、返ってきたときにその番号がまだ最新かを見る。
 * 用途ごとに scope を分ける (別の画面の待ちを巻き込まないため)
 */
export interface ReqSeq {
  /** 新しい番号を発行する。これで、それまでの番号は古くなる */
  start(scope: string): number;
  /** その番号がまだ最新か (古ければ応答を捨てる) */
  isLatest(scope: string, n: number): boolean;
  /**
   * 待っているものをまとめて古くする。
   * 取り消し・確定など「もうこの待ちは要らない」ときに呼ぶ
   */
  drop(scope: string): void;
}

export function createReqSeq(): ReqSeq {
  const seq = new Map<string, number>();
  const bump = (scope: string) => {
    const n = (seq.get(scope) ?? 0) + 1;
    seq.set(scope, n);
    return n;
  };
  return {
    start: bump,
    isLatest: (scope, n) => seq.get(scope) === n,
    drop: (scope) => {
      bump(scope);
    },
  };
}
