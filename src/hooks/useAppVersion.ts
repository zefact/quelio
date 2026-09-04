import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/**
 * アプリのバージョン (読めるまでは空文字)。
 *
 * 0.x 系のあいだはβ扱いなので、名乗りの横にその印を出す。
 * DBの画面とCSVエディタで同じ判断をするため、ここに1つ置く
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v ?? ""))
      .catch(() => {
        /* 読めなくても画面は出す (βの印が出ないだけ) */
      });
  }, []);
  return version;
}

/** 0.x 系ならβ */
export function isBetaVersion(version: string): boolean {
  return version.startsWith("0.");
}
