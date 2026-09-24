/**
 * Valkeyコンソールで、実行前に確認を挟むかの判断。
 *
 * 確認が要るコマンドを拾うのはRust側 (`find_destructive`)。
 * ここにあるのは「調べた結果をどう扱うか」だけで、画面には触れない
 */

/** 判定できなかったとき、本番で確認に出す説明 */
export const KV_CHECK_FAILED = "判定できませんでした。本番環境のため確認します";

/** 判定のあとにやること */
export type KvGuardStep =
  /** 確認を出す (一覧に並べるコマンド名) */
  | { kind: "confirm"; commands: string[] }
  /** そのまま実行する */
  | { kind: "run" };

/**
 * 確認が要るコマンドの一覧から、次の段階を決める。
 *
 * `found` が null なのは「判定そのものができなかった」とき。
 * SQLエディタ側と同じで、本番だけは確認する側に倒す
 * (何が流れるか分からないまま本番へ投げるより害が小さい)
 */
export function afterKvCheck(
  found: string[] | null,
  /** 本番の接続か */
  prod = false
): KvGuardStep {
  if (found && found.length > 0) return { kind: "confirm", commands: found };
  if (found === null && prod) {
    return { kind: "confirm", commands: [KV_CHECK_FAILED] };
  }
  return { kind: "run" };
}
