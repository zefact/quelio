import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** ダウンロード進捗 (0〜100。総サイズ不明なら null) */
export type ProgressHandler = (percent: number | null) => void;

/** アップデートを確認する。開発モードや通信不可時はnull */
export async function checkForUpdate(): Promise<Update | null> {
  if (import.meta.env.DEV) return null;
  return await check();
}

/** アップデートをダウンロード・インストールして再起動する */
export async function installUpdate(
  update: Update,
  onProgress: ProgressHandler
): Promise<void> {
  let total: number | null = null;
  let downloaded = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress(total ? 0 : null);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress(total ? Math.round((downloaded / total) * 100) : null);
        break;
      case "Finished":
        onProgress(100);
        break;
    }
  });
  await relaunch();
}

/** 再起動すると失われる作業 (未確定のトランザクション・実行中のSQL) がある接続 */
export interface UpdateRisk {
  /** その接続の名前 */
  names: string[];
  /** 実行中のSQLがあって、トランザクションの状態を読めない接続が混ざっているか */
  busy: boolean;
}

/** 確かめ方 (タブの状態を持っている App が登録する) */
let riskCheck: (() => Promise<UpdateRisk>) | null = null;

/** 再起動の前に確かめる方法を登録する */
export function setUpdateRiskCheck(fn: (() => Promise<UpdateRisk>) | null) {
  riskCheck = fn;
}

/**
 * 更新して再起動する前に、失われる作業があるか確かめる。
 * 読めなかったときは止めない (更新できなくなるのを避ける)
 */
export async function checkUpdateRisk(): Promise<UpdateRisk> {
  try {
    return riskCheck ? await riskCheck() : { names: [], busy: false };
  } catch {
    return { names: [], busy: false };
  }
}
