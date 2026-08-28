import { useEffect, useState } from "react";
import { APP_SETTINGS_EVENT, getAppSettings } from "../api";
import { DEFAULT_APP_SETTINGS } from "./useAppSettings";
import type { AppSettings } from "../types";

/**
 * アプリ設定を読み、変更に追従する (読むだけの画面用)。
 *
 * 追従するきっかけは2つ:
 * - 同じウィンドウの設定モーダルでの変更 (APP_SETTINGS_EVENT)
 * - 別ウィンドウでの変更 (このウィンドウへ戻ってきたとき)
 *
 * 読めるまでは既定値を返すので、呼び出し側でnullを扱わなくてよい
 */
export function useWatchedSettings(): AppSettings {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getAppSettings()
        .then((s) => {
          if (alive) setSettings(s);
        })
        .catch(() => {
          /* 読めなければ既定値のままにする */
        });
    };
    load();
    window.addEventListener(APP_SETTINGS_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener(APP_SETTINGS_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, []);

  return settings;
}
