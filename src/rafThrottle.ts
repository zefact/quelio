/**
 * 直近の呼び出しだけを次の描画フレームで実行する。
 * mousemoveは1フレームに何度も飛んでくるため、そのまま状態更新につなぐと
 * 描画が追いつかずカクつく。1フレームに1回へ間引くための小さなヘルパー
 */
export function rafThrottle<T>(fn: (arg: T) => void) {
  let id = 0;
  let last: T;
  return {
    /** 次のフレームで最新の引数だけを渡してfnを呼ぶ */
    run(arg: T) {
      last = arg;
      if (id) return;
      id = requestAnimationFrame(() => {
        id = 0;
        fn(last);
      });
    },
    /** 予約済みのフレームを取り消す (ドラッグ終了時など) */
    cancel() {
      if (id) cancelAnimationFrame(id);
      id = 0;
    },
  };
}
