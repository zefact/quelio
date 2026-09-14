/**
 * ヘルプに出す話題の一覧。
 *
 * 話題ごとに1ファイルにしてあるので、足すときは
 * そのファイルを作って、下の TOPICS へ並べるだけで済む。
 * 画面 (HelpDialog) は触らなくてよい
 */
import type { DbType } from "../../types";
import { COLLATION } from "./collationTopic";
import { EXPLAIN } from "./explainTopic";
import { INDEX } from "./indexTopic";
import { SHORTCUT } from "./shortcutTopic";
import type { HelpTopic } from "./helpTypes";

export type { HelpSection, HelpTopic } from "./helpTypes";

/** 出せる話題 (並べた順に左の一覧へ出る) */
const TOPICS: HelpTopic[] = [EXPLAIN, INDEX, COLLATION, SHORTCUT];

/** そのDBで出せる話題だけを返す */
export function topicsFor(dbType: DbType): HelpTopic[] {
  return TOPICS.filter((t) => !t.dbTypes || t.dbTypes.includes(dbType));
}
