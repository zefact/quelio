/** 設定画面などの通知の種類 (見た目と消え方を変える) */
export type NotifyLevel = "success" | "error";

/** 通知を出す関数 (成功は自動で消え、失敗は残す) */
export type Notify = (msg: string, level?: NotifyLevel) => void;
