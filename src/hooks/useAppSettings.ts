import { useEffect, useState } from "react";
import { getAppSettings, saveAppSettings } from "../api";
import type { AppSettings } from "../types";

/** 読み込み前に使う既定値 (バックエンドの既定と揃えておく) */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  commentDelimiter: "（",
  structureCommentMode: "comment",
  showRowNumbers: true,
  queryTimeoutSecs: 60,
  downloadDir: "",
  autocompleteEnabled: true,
  autocompleteDelayMs: 100,
};

/**
 * アプリ設定の読み込みと保存 (設定画面の各ページで共通)。
 * 変更は即保存し、成功時は何も出さない
 */
export function useAppSettings(notify: (msg: string) => void) {
  const [app, setApp] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    getAppSettings()
      .then(setApp)
      .catch(() => {});
  }, []);

  const saveApp = async (next: AppSettings) => {
    setApp(next);
    try {
      await saveAppSettings(next);
    } catch (e) {
      notify(String(e));
    }
  };

  return { app, setApp, saveApp };
}
