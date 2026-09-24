/**
 * 接続フォームと接続一覧で、環境の設定を促すときの文言と条件。
 *
 * 本番かどうかで効く仕組み (更新の確認・AI連携の制限) が変わるので、
 * 環境が未設定のままだと、本番を本番として扱えない。
 * ここでは画面に触れない判定と文だけを置く
 */
import type { ConnectionEnv } from "./types";

/**
 * 本番なのに更新できる状態か。
 *
 * 読み取り専用をすすめる案内と、保存するときの一文を出す条件。
 * 強制はしない (本番でも更新が要る運用はある)
 */
export function prodWritable(
  env: ConnectionEnv | undefined,
  readOnly: boolean | undefined
): boolean {
  return env === "prod" && !readOnly;
}

/** 読み取り専用をすすめる案内 */
export const READ_ONLY_SUGGEST = "本番環境は読み取り専用にすることをおすすめします";

/**
 * 更新できる状態のまま保存するときの一文。
 *
 * 「一度出したら以後は出さない」にはしない。
 * 承知したことを覚えてしまうと、次に開いた人には何も見えなくなる。
 * 煩わしさより、保存のたびに1行読んでもらう方を選ぶ
 */
export const PROD_SAVE_NOTE = "本番環境に更新可能な状態で保存します。";

/** 環境欄の下に出す補足 */
export function envFieldNote(env: ConnectionEnv | undefined): string {
  return env === "prod"
    ? "接続のときに確認を出し、更新のたびに確認を挟みます (定義の変更の確認は設定で外せません)"
    : "本番は必ず設定してください。本番では更新の確認・AI連携の制限が効きます";
}

/** 接続一覧に出す環境のラベル (未設定はそうと分かるようにする) */
export function envListLabel(env: ConnectionEnv | undefined): string {
  return env ? "" : "環境未設定";
}
