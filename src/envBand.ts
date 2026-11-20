/**
 * 「今どの環境に繋いでいるか」を常に見せるための、文言と印の決め方。
 *
 * 環境 (本番 / ステージング / 開発) は接続の設定に入っているが、
 * これまでは接続したときの確認と、ツールバー上端の細い線・画面下のバッジ
 * にしか出ていなかった。作業に入ってしばらくすると、
 * 「今つないでいるのが本番」だと分かる手がかりが視界から消えてしまう。
 *
 * ここでは画面に触れない判定だけを置き、タブとセッション画面の両方から使う。
 * 色そのものは `envColor` に任せる (色を増やさないため)
 */
import type { ConnectionEnv } from "./types";
import { envLabel } from "./types";

/** タブに付ける環境の印 */
export interface TabEnvMark {
  /** タブに出すラベル (「本番」) */
  label: string;
  /** どの環境か (色を引くのに使う) */
  env: ConnectionEnv;
}

/**
 * 環境の印の出し方の決まり (どの画面もこれに従う)。
 *
 *   本番・ステージング … タブの印 + セッション画面の帯
 *   すべての環境       … ステータスバーのバッジ
 *
 * 開発・未設定まで帯やタブの印を付けると、どの画面も色つきになって
 * 「本番だけは違う」という手がかりにならない。
 * そのため目立つ印は、間違えると困る2つの環境だけに付ける
 */
export function isMarkedEnv(
  env: ConnectionEnv | undefined
): env is "prod" | "staging" {
  return env === "prod" || env === "staging";
}

/**
 * タブに環境の印を付けるか。
 *
 * 本番とステージングだけ (isMarkedEnv の決まり)。
 * 未接続のタブ (まだ接続先を選んでいる途中) は対象外
 */
export function tabEnvMark(
  env: ConnectionEnv | undefined,
  connected: boolean
): TabEnvMark | null {
  if (!connected || !isMarkedEnv(env)) return null;
  return { label: envLabel(env), env };
}

/** セッション画面の上に出す帯 */
export interface EnvBandText {
  /** 帯に出す1行 (「本番環境 — 社内MySQL」) */
  text: string;
  /** どの環境か (色と控えめさの切り替えに使う) */
  env: ConnectionEnv;
}

/**
 * セッション画面に帯を出すか、出すなら何と書くか。
 *
 * 本番とステージングだけ。開発・未設定で帯を出すと、
 * どの画面にも帯があることになって、本番の帯が目に留まらなくなる
 */
export function envBandText(
  env: ConnectionEnv | undefined,
  connection: string
): EnvBandText | null {
  if (!isMarkedEnv(env)) return null;
  const name = connection.trim() || "(無名)";
  // 本番だけは「環境」を付けて、他と字面が揃わないようにする
  const head = env === "prod" ? "本番環境" : envLabel(env);
  return { text: `${head} — ${name}`, env };
}
