import type { CSSProperties } from "react";
import type { ConnectionEnv } from "../types";
import { envColor } from "../types";
import { envBandText } from "../envBand";

interface Props {
  /** 接続先の環境 (未設定なら帯は出ない) */
  env: ConnectionEnv | undefined;
  /** 接続名 (どこに繋いでいるかを帯に出す) */
  connection: string;
}

/**
 * セッション画面の上に出す環境の帯。
 *
 * 本番はいちばん強く (環境色の地)、ステージングは控えめに (左端の線だけ)。
 * 開発・未設定では何も出さない
 */
export function EnvBand({ env, connection }: Props) {
  const band = envBandText(env, connection);
  if (!band) return null;
  return (
    <div
      className={`env-band ${band.env}`}
      // 帯の文字は接続名なので、ページ内検索の対象にしない
      data-find-skip
      style={{ "--env-color": envColor(band.env) } as CSSProperties}
    >
      {band.text}
    </div>
  );
}
