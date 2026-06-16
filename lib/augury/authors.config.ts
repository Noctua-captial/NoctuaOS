// The traders Augury tracks. Seeds the `authors` table on first ingest.
//
// TODO(augury): replace the PLACEHOLDER handles below ("trader_one",
// "trader_two") with the two real trader handles to track. Use the handle only
// — no leading "@". `platformUserId`/`displayName` are filled in automatically
// on first ingest from the source, so they can stay omitted here.
import type { Platform } from "@/lib/augury/types";

export interface TrackedAuthor {
  handle: string; // platform handle, without the leading @
  platform: Platform; // "x"
  displayName?: string; // optional friendly name; backfilled from the source if omitted
  active: boolean; // false to pause ingest without deleting history
}

export const TRACKED_AUTHORS: TrackedAuthor[] = [
  { handle: "trader_one", platform: "x", active: true },
  { handle: "trader_two", platform: "x", active: true },
];
