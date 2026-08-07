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
