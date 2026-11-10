import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const lattes = sqliteTable("lattes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  madeAt: text("made_at").notNull(),
  location: text("location"),
  milk: text("milk"),
  espressoQuality: integer("espresso_quality"),
  overallQuality: integer("overall_quality"),
  // Legacy 1–5 latte-art rating, retired 2026-11-08: the 0–10
  // matchup score is now the single art rating. The column stays so old
  // rows keep their history, but nothing reads, writes, or shows it.
  latteArtQuality: integer("latte_art_quality"),
  // 1–5 rating of how well the milk was steamed (texture, temperature) —
  // distinct from `milk`, which records the milk type (e.g. Whole milk).
  milkQuality: integer("milk_quality"),
  notes: text("notes"),
  // Internal Elo used only to derive the 0–10 art score the UI
  // shows. Seeded from the old 1–5 latte-art rating by migration 0003.
  artElo: integer("art_elo").notNull().default(1500),
  artWins: integer("art_wins").notNull().default(0),
  artLosses: integer("art_losses").notNull().default(0),
  artComparisons: integer("art_comparisons").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const latteComparisons = sqliteTable("latte_comparisons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  winnerId: integer("winner_id")
    .notNull()
    .references(() => lattes.id, { onDelete: "cascade" }),
  loserId: integer("loser_id")
    .notNull()
    .references(() => lattes.id, { onDelete: "cascade" }),
  winnerEloBefore: integer("winner_elo_before").notNull(),
  loserEloBefore: integer("loser_elo_before").notNull(),
  winnerEloAfter: integer("winner_elo_after").notNull(),
  loserEloAfter: integer("loser_elo_after").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const lattePhotos = sqliteTable("latte_photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  latteId: integer("latte_id")
    .notNull()
    .references(() => lattes.id, { onDelete: "cascade" }),
  blobKey: text("blob_key").notNull(),
  mimeType: text("mime_type").notNull(),
  sortOrder: integer("sort_order").notNull(),
});
