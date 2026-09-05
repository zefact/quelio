/**
 * 実行の依頼を受け取ってから、入力画面を出す・そのまま実行するまで。
 *
 * パラメータ (:name / @name) があるSQLは、保存してある値を読み、
 * 無い分はスキーマから型を推測してから入力画面を出す。
 * どちらもバックエンドへの往復で、その間はまだ実行中にならず、
 * 入力画面も出ていない。つまり利用者から見れば何も起きていない状態で、
 * もう一度実行できてしまう。
 *
 * このとき困るのは「2つ並んで走ること」よりも、
 * **やめたはずの実行が、遅れて画面を開き直すこと**。
 * 開き直った画面をそのまま確定すると、やめたはずのSQLが走る。
 *
 * そこで、押した瞬間に取った受付票 (RunTicket) を持ち回り、
 * 依頼を受けた時点と、準備が揃った時点の2回、まだ最新かを見る。
 * 取り消し・確定・タブを閉じたときに番号を捨てれば、
 * 押した時点がそれより前の要求は、どこまで進んでいても落ちる。
 *
 * 宛先も受付票から決める。待っている間に別の接続タブへ切り替えられても、
 * 押したときの接続・データベース・シートのまま実行する
 */
import type { ParamKind, ParamValue } from "./sqlParams";
import type { ReqSeq } from "./reqSeq";
import { isCurrentRun } from "./runTicket";
import type { RunTicket } from "./runTicket";

/** 入力画面へ渡すもの */
export interface ParamRequest {
  /** 押した時点の宛先 (接続タブ・データベース・シート) と受付番号 */
  ticket: RunTicket;
  /** 値を保存する単位 (接続プロファイルID) */
  scope: string;
  offset: number;
  sql: string;
  params: string[];
  initial: Record<string, ParamValue>;
  transaction: boolean;
  explain?: "explain" | "analyze";
}

/** 準備に必要な外との行き来 */
export interface ParamDeps {
  /** 接続ごとに保存してある値 (読めなければ空でよい) */
  saved: (scope: string) => Promise<Record<string, { value: string; kind: string }>>;
  /** スキーマから型を推測する */
  inferKind: (name: string) => Promise<ParamKind>;
}

/** 依頼をどう扱うか */
export type RunHandoff =
  /** もう古い要求 (取り消された・別の実行が始まった・タブが閉じた) */
  | { kind: "stale" }
  /** 入力画面を出す */
  | { kind: "params"; request: ParamRequest }
  /** そのまま実行する */
  | { kind: "run" };

/** 入力画面に出す初期値をそろえる */
async function initialValues(
  params: string[],
  scope: string,
  deps: ParamDeps
): Promise<Record<string, ParamValue>> {
  const saved = await deps
    .saved(scope)
    .catch(() => ({}) as Record<string, { value: string; kind: string }>);

  const initial: Record<string, ParamValue> = {};
  for (const name of params) {
    const s = saved[name];
    // 型は「明示的に選ばれた保存値」を優先し、無ければスキーマから推測する
    const kind =
      s && s.kind && s.kind !== "auto"
        ? (s.kind as ParamKind)
        : await deps.inferKind(name);
    initial[name] = { value: s?.value ?? "", kind };
  }
  return initial;
}

/**
 * 実行の依頼を受け取ってから先を決める。
 *
 * `token` は押した瞬間に取った受付番号。
 * 依頼を受けた時点で古ければ何もしない (押した後に取り消された)。
 * 準備を待っている間に古くなった場合も、そこで落とす
 */
export async function handoffRun(
  seq: ReqSeq,
  base: Omit<ParamRequest, "initial">,
  deps: ParamDeps
): Promise<RunHandoff> {
  /*
   * 照合先は受付票の中のタブから決める (今表示しているタブからは決めない)。
   * 番号はタブごとの連番なので、別のタブの同じ番号と偶然一致してしまう
   */
  // 押してから届くまでの間に取り消された・別のが始まった
  if (!isCurrentRun(seq, base.ticket)) return { kind: "stale" };
  if (base.params.length === 0) return { kind: "run" };

  const initial = await initialValues(base.params, base.scope, deps);
  // そろえている間に取り消された・別のが始まった
  if (!isCurrentRun(seq, base.ticket)) return { kind: "stale" };
  return { kind: "params", request: { ...base, initial } };
}
