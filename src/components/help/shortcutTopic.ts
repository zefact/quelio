/**
 * ヘルプ: キーボードショートカット。
 *
 * 中身は shortcuts.ts が持っているものをそのまま表にする
 * (⌘/ の一覧と同じ元を見るので、片方だけ古くなることがない)。
 * DBによって変わる話ではないので、出し分けはしない
 */
import type { HelpSection, HelpTopic } from "./helpTypes";
import { SHORTCUTS } from "../../shortcuts";

/** まとまり1つを、そのまま「キー / すること」の表にする */
function toSection(group: (typeof SHORTCUTS)[number]): HelpSection {
  return {
    title: group.title,
    table: {
      head: ["キー・操作", "すること"],
      rows: group.items.map(([keys, desc]) => [keys, desc]),
    },
  };
}

export const SHORTCUT: HelpTopic = {
  id: "shortcut",
  label: "ショートカット",
  note: "キー操作の一覧",
  // どのDBでも同じなので、出し分けない
  sections: () => [
    {
      title: "見方",
      lines: [
        "キーの書き方は使っているOSに合わせて出しています (macOS は記号、Windows・Linux は Ctrl+ などの文字)。",
        "「タブ・ウィンドウ」「SQLエディタ」「結果グリッド」のぶんは、⌘ (Ctrl) + / でいつでも呼び出せます。",
      ],
    },
    ...SHORTCUTS.map(toSection),
  ],
};
