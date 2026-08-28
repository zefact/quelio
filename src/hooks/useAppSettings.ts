import { useEffect, useState } from "react";
import { getAppSettings, saveAppSettings } from "../api";
import type { Notify } from "../notify";
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
  confirmAlter: true,
  restoreTabs: false,
};

/**
 * アプリ設定の読み込みと保存 (設定画面の各ページで共通)。
 * 変更は即保存し、結果を通知する
 */
export function useAppSettings(notify: Notify) {
  const [app, setApp] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    getAppSettings()
      .then(setApp)
      .catch((e) => notify(`設定を読み込めませんでした: ${e}`, "error"));
    // 初回だけ読む (通知の関数は毎回作り直されるので依存に入れない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveApp = async (next: AppSettings) => {
    setApp(next);
    try {
      await saveAppSettings(next);
      notify("保存しました");
    } catch (e) {
      notify(`保存できませんでした: ${e}`, "error");
    }
  };

  return { app, setApp, saveApp };
}
