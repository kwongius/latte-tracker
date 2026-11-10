import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

const rating = z.number().int().min(1).max(5).nullable();
const photoInput = z.object({
  dataBase64: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  name: z.string().max(180).optional(),
});

const photoResponse = z.object({
  id: z.number(),
  url: z.string(),
  mimeType: z.string(),
  sortOrder: z.number(),
});

const latteResponse = z.object({
  id: z.number(),
  madeAt: z.string(),
  location: z.string().nullable(),
  milk: z.string().nullable(),
  espressoQuality: z.number().nullable(),
  overallQuality: z.number().nullable(),
  milkQuality: z.number().nullable(),
  notes: z.string().nullable(),
  // Art score on a 0–10 scale, derived from head-to-head
  // latte-art comparisons. Raw Elo stays server-side.
  artScore: z.number(),
  artWins: z.number(),
  artLosses: z.number(),
  artComparisons: z.number(),
  createdAt: z.string(),
  photos: z.array(photoResponse),
});

const OWNER_REQUIRED = "This is Kevin's private latte journal — sign in as the owner to use it.";

function isOwner(ctx: Ctx): boolean {
  // Owner-only journal: guests and signed-out visitors have no viewer, and
  // a missing viewer is never proof of ownership — only an explicit owner
  // viewer passes.
  return ctx.viewer?.isOwner === true;
}

function cleanOptional(value: string | null): string | null {
  const cleaned = value?.trim() ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

// Map internal Elo onto a 0–10 scale: 1500 (a brand-new,
// unranked pour) sits at 5.0, and the scale saturates smoothly toward
// 0 and 10 instead of running off to raw Elo numbers.
function eloToScore(elo: number): number {
  const score = 10 / (1 + Math.pow(10, -(elo - 1500) / 400));
  return Math.round(score * 100) / 100;
}

// Every pour starts at the 1500 baseline (5.0 on the 0–10 scale) and
// earns its place purely through head-to-head matchups. The retired 1–5
// art rating no longer seeds anything.

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j] as T;
    copy[j] = tmp as T;
  }
  return copy;
}

export const Actions = {
  listLattes: defineAction({
    description: "List the latte journal entries with their photos and 0–10 latte-art scores.",
    request: z.object({ limit: z.number().int().positive().max(200).default(100) }),
    response: z.object({
      lattes: z.array(latteResponse),
      lastMilk: z.string().nullable(),
      previousLocations: z.array(z.string()),
      totalComparisons: z.number(),
      ownerRequired: z.boolean(),
    }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) {
        return { lattes: [], lastMilk: null, previousLocations: [], totalComparisons: 0, ownerRequired: true };
      }
      const db = ctx.db<typeof schema>();
      const latteRows = await db
        .select()
        .from(schema.lattes)
        .orderBy(desc(schema.lattes.madeAt), desc(schema.lattes.id))
        .limit(args.limit);
      const photoRows = await db
        .select()
        .from(schema.lattePhotos)
        .orderBy(asc(schema.lattePhotos.sortOrder));

      const photosByLatte = new Map<number, z.infer<typeof photoResponse>[]>();
      for (const photo of photoRows) {
        try {
          const url = await ctx.blobs.getUrl(photo.blobKey);
          const item = {
            id: photo.id,
            url,
            mimeType: photo.mimeType,
            sortOrder: photo.sortOrder,
          };
          const existing = photosByLatte.get(photo.latteId) ?? [];
          existing.push(item);
          photosByLatte.set(photo.latteId, existing);
        } catch {
          // Keep the entry useful even if one stored image is unavailable.
        }
      }

      const allRows = await db
        .select({ milk: schema.lattes.milk, location: schema.lattes.location })
        .from(schema.lattes)
        .orderBy(desc(schema.lattes.madeAt), desc(schema.lattes.id));
      const lastMilk = allRows.find((row) => cleanOptional(row.milk) !== null)?.milk?.trim() ?? null;
      const previousLocations = Array.from(
        new Set(allRows.map((row) => cleanOptional(row.location)).filter((value): value is string => value !== null)),
      ).slice(0, 12);

      const comparisonRows = await db.select({ id: schema.latteComparisons.id }).from(schema.latteComparisons);

      return {
        lattes: latteRows.map((row) => ({
          id: row.id,
          madeAt: row.madeAt,
          location: row.location,
          milk: row.milk,
          espressoQuality: row.espressoQuality,
          overallQuality: row.overallQuality,
          milkQuality: row.milkQuality,
          notes: row.notes,
          artScore: eloToScore(row.artElo),
          artWins: row.artWins,
          artLosses: row.artLosses,
          artComparisons: row.artComparisons,
          createdAt: row.createdAt.toISOString(),
          photos: photosByLatte.get(row.id) ?? [],
        })),
        lastMilk,
        previousLocations,
        totalComparisons: comparisonRows.length,
        ownerRequired: false,
      };
    },
  }),

  addLatte: defineAction({
    description: "Log a new latte with optional details, ratings, and up to 8 photos; it starts unranked on the art leaderboard until compared.",
    request: z.object({
      madeAt: z.string().datetime(),
      location: z.string().max(120).nullable(),
      milk: z.string().max(80).nullable(),
      espressoQuality: rating,
      overallQuality: rating,
      milkQuality: rating,
      notes: z.string().max(1200).nullable(),
      photos: z.array(photoInput).max(8),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number().optional(),
      error: z.string().optional(),
    }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, error: OWNER_REQUIRED };
      const db = ctx.db<typeof schema>();
      const savedKeys: string[] = [];
      try {
        for (let index = 0; index < args.photos.length; index += 1) {
          const photo = args.photos[index];
          if (!photo) continue;
          const key = `latte-photos/${crypto.randomUUID()}`;
          const bytes = Buffer.from(photo.dataBase64, "base64");
          await ctx.blobs.put(key, bytes, { contentType: photo.mimeType });
          savedKeys.push(key);
        }

        const insertedRows = await db
          .insert(schema.lattes)
          .values({
            madeAt: args.madeAt,
            location: cleanOptional(args.location),
            milk: cleanOptional(args.milk),
            espressoQuality: args.espressoQuality,
            overallQuality: args.overallQuality,
            milkQuality: args.milkQuality,
            notes: cleanOptional(args.notes),
            artElo: 1500,
          })
          .returning({ id: schema.lattes.id });
        const inserted = insertedRows[0];
        if (!inserted) throw new Error("The entry could not be saved.");

        if (savedKeys.length > 0) {
          await db.insert(schema.lattePhotos).values(
            savedKeys.map((blobKey, index) => ({
              latteId: inserted.id,
              blobKey,
              mimeType: args.photos[index]?.mimeType ?? "image/jpeg",
              sortOrder: index,
            })),
          );
        }
        ctx.invalidateQueries();
        return { ok: true, id: inserted.id };
      } catch {
        for (const key of savedKeys) {
          try {
            await ctx.blobs.delete(key);
          } catch {
            // Best-effort cleanup only.
          }
        }
        return { ok: false, error: "That latte wasn’t saved. Please try again." };
      }
    },
  }),

  updateLatte: defineAction({
    description: "Edit an existing latte entry: update when it was made, location, milk, ratings, and notes, and add, remove, or reorder its photos. The art score is earned through matchups and is not edited directly.",
    request: z.object({
      id: z.number().int().positive(),
      madeAt: z.string().datetime(),
      location: z.string().max(120).nullable(),
      milk: z.string().max(80).nullable(),
      espressoQuality: rating,
      overallQuality: rating,
      milkQuality: rating,
      notes: z.string().max(1200).nullable(),
      keepPhotoIds: z.array(z.number().int().positive()).max(8),
      newPhotos: z.array(photoInput).max(8),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number().optional(),
      error: z.string().optional(),
    }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, error: OWNER_REQUIRED };
      if (args.keepPhotoIds.length + args.newPhotos.length > 8) {
        return { ok: false, error: "You can keep up to 8 photos per latte." };
      }
      // Duplicate keep ids would corrupt ordering — reject them.
      if (new Set(args.keepPhotoIds).size !== args.keepPhotoIds.length) {
        return { ok: false, error: "That photo list looks off. Please try again." };
      }
      const db = ctx.db<typeof schema>();
      const existingRows = await db
        .select()
        .from(schema.lattes)
        .where(eq(schema.lattes.id, args.id))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) return { ok: false, error: "That entry no longer exists." };

      const photoRows = await db
        .select()
        .from(schema.lattePhotos)
        .where(eq(schema.lattePhotos.latteId, args.id))
        .orderBy(asc(schema.lattePhotos.sortOrder));
      const photoById = new Map(photoRows.map((row) => [row.id, row]));
      // Every kept photo must actually belong to this entry.
      for (const keepId of args.keepPhotoIds) {
        if (!photoById.has(keepId)) {
          return { ok: false, error: "One of those photos no longer belongs to this entry." };
        }
      }
      const keepSet = new Set(args.keepPhotoIds);
      const removedPhotos = photoRows.filter((row) => !keepSet.has(row.id));

      const savedKeys: string[] = [];
      try {
        for (let index = 0; index < args.newPhotos.length; index += 1) {
          const photo = args.newPhotos[index];
          if (!photo) continue;
          const key = `latte-photos/${crypto.randomUUID()}`;
          const bytes = Buffer.from(photo.dataBase64, "base64");
          await ctx.blobs.put(key, bytes, { contentType: photo.mimeType });
          savedKeys.push(key);
        }

        await db
          .update(schema.lattes)
          .set({
            madeAt: args.madeAt,
            location: cleanOptional(args.location),
            milk: cleanOptional(args.milk),
            espressoQuality: args.espressoQuality,
            overallQuality: args.overallQuality,
            milkQuality: args.milkQuality,
            notes: cleanOptional(args.notes),
          })
          .where(eq(schema.lattes.id, args.id));

        // Reorder kept photos to the order the client sent.
        for (let index = 0; index < args.keepPhotoIds.length; index += 1) {
          const keepId = args.keepPhotoIds[index];
          if (keepId === undefined) continue;
          await db
            .update(schema.lattePhotos)
            .set({ sortOrder: index })
            .where(eq(schema.lattePhotos.id, keepId));
        }

        // Append new photos after the kept ones, in sent order.
        if (savedKeys.length > 0) {
          await db.insert(schema.lattePhotos).values(
            savedKeys.map((blobKey, index) => ({
              latteId: args.id,
              blobKey,
              mimeType: args.newPhotos[index]?.mimeType ?? "image/jpeg",
              sortOrder: args.keepPhotoIds.length + index,
            })),
          );
        }

        // Remove photos the user dropped, rows first then blobs.
        for (const removed of removedPhotos) {
          await db.delete(schema.lattePhotos).where(eq(schema.lattePhotos.id, removed.id));
        }
        for (const removed of removedPhotos) {
          try {
            await ctx.blobs.delete(removed.blobKey);
          } catch {
            // Best-effort cleanup only.
          }
        }

        ctx.invalidateQueries();
        return { ok: true, id: args.id };
      } catch {
        for (const key of savedKeys) {
          try {
            await ctx.blobs.delete(key);
          } catch {
            // Best-effort cleanup only.
          }
        }
        return { ok: false, error: "Those changes weren’t saved. Please try again." };
      }
    },
  }),

  suggestMatchup: defineAction({
    description: "Suggest the next head-to-head latte-art matchup: a given pour against a similarly scored pour it has rarely faced, or the two pours most in need of calibration.",
    request: z.object({ focusId: z.number().int().positive().nullable() }),
    response: z.object({
      ok: z.boolean(),
      aId: z.number().optional(),
      bId: z.number().optional(),
      error: z.string().optional(),
    }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, error: OWNER_REQUIRED };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.lattes.id,
          artElo: schema.lattes.artElo,
          artComparisons: schema.lattes.artComparisons,
        })
        .from(schema.lattes);
      const photoRows = await db.select({ latteId: schema.lattePhotos.latteId }).from(schema.lattePhotos);
      const withPhoto = new Set(photoRows.map((row) => row.latteId));
      const eligible = rows.filter((row) => withPhoto.has(row.id));
      if (eligible.length < 2) {
        return { ok: false, error: "You need at least two lattes with photos before art matchups can start." };
      }

      const comparisons = await db
        .select({ winnerId: schema.latteComparisons.winnerId, loserId: schema.latteComparisons.loserId })
        .from(schema.latteComparisons);
      const facedCount = (x: number, y: number) =>
        comparisons.filter(
          (row) => (row.winnerId === x && row.loserId === y) || (row.winnerId === y && row.loserId === x),
        ).length;

      if (args.focusId !== null) {
        const focus = eligible.find((row) => row.id === args.focusId);
        if (!focus) return { ok: false, error: "That pour has no photo to rank yet." };
        const candidates = shuffled(eligible.filter((row) => row.id !== focus.id));
        candidates.sort(
          (a, b) =>
            facedCount(focus.id, a.id) - facedCount(focus.id, b.id) ||
            Math.abs(a.artElo - focus.artElo) - Math.abs(b.artElo - focus.artElo) ||
            a.artComparisons - b.artComparisons,
        );
        const pick = candidates[0];
        if (!pick) return { ok: false, error: "No other latte with a photo to compare against yet." };
        return { ok: true, aId: focus.id, bId: pick.id };
      }

      const ordered = shuffled(eligible);
      ordered.sort((a, b) => a.artComparisons - b.artComparisons);
      const a = ordered[0];
      if (!a) return { ok: false, error: "No lattes to rank yet." };
      const rest = shuffled(eligible.filter((row) => row.id !== a.id));
      rest.sort(
        (x, y) =>
          facedCount(a.id, x.id) - facedCount(a.id, y.id) ||
          Math.abs(x.artElo - a.artElo) - Math.abs(y.artElo - a.artElo) ||
          x.artComparisons - y.artComparisons,
      );
      const b = rest[0];
      if (!b) return { ok: false, error: "No second latte to rank yet." };
      return { ok: true, aId: a.id, bId: b.id };
    },
  }),

  recordComparison: defineAction({
    description: "Record which of two pours had the better latte art and update both pours' 0–10 art scores.",
    request: z.object({
      winnerId: z.number().int().positive(),
      loserId: z.number().int().positive(),
    }),
    response: z.object({
      ok: z.boolean(),
      winnerArtScore: z.number().optional(),
      loserArtScore: z.number().optional(),
      error: z.string().optional(),
    }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, error: OWNER_REQUIRED };
      if (args.winnerId === args.loserId) return { ok: false, error: "Pick two different pours." };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.lattes)
        .where(or(eq(schema.lattes.id, args.winnerId), eq(schema.lattes.id, args.loserId)));
      const winner = rows.find((row) => row.id === args.winnerId);
      const loser = rows.find((row) => row.id === args.loserId);
      if (!winner || !loser) return { ok: false, error: "One of those pours no longer exists." };

      // Standard Elo update (K=32) underneath; only the 0–10 score is shown.
      const expectedWinner = 1 / (1 + Math.pow(10, (loser.artElo - winner.artElo) / 400));
      const swing = Math.max(1, Math.round(32 * (1 - expectedWinner)));
      const winnerEloAfter = winner.artElo + swing;
      const loserEloAfter = loser.artElo - swing;

      await db
        .update(schema.lattes)
        .set({
          artElo: winnerEloAfter,
          artWins: winner.artWins + 1,
          artComparisons: winner.artComparisons + 1,
        })
        .where(eq(schema.lattes.id, winner.id));
      await db
        .update(schema.lattes)
        .set({
          artElo: loserEloAfter,
          artLosses: loser.artLosses + 1,
          artComparisons: loser.artComparisons + 1,
        })
        .where(eq(schema.lattes.id, loser.id));
      await db.insert(schema.latteComparisons).values({
        winnerId: winner.id,
        loserId: loser.id,
        winnerEloBefore: winner.artElo,
        loserEloBefore: loser.artElo,
        winnerEloAfter,
        loserEloAfter,
      });
      ctx.invalidateQueries();
      return { ok: true, winnerArtScore: eloToScore(winnerEloAfter), loserArtScore: eloToScore(loserEloAfter) };
    },
  }),

  recomputeArtScores: defineAction({
    description: "Recompute all latte-art scores by replaying the remaining comparison history in chronological order from each pour's starting score at the head of that history, fixing drift from matchups deleted before score rollback existed. Only art scores change; win/loss counts and comparison history are untouched.",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      totalLattes: z.number().optional(),
      totalPhotos: z.number().optional(),
      totalComparisons: z.number().optional(),
      changedCount: z.number().optional(),
      results: z
        .array(
          z.object({
            id: z.number(),
            beforeScore: z.number(),
            afterScore: z.number(),
            beforeElo: z.number(),
            afterElo: z.number(),
            changed: z.boolean(),
          }),
        )
        .optional(),
      score6: z.number().optional(),
      score11: z.number().optional(),
      error: z.string().optional(),
    }),
    async handler(ctx) {
      // Owner-gated like the rest of the journal, with one exception:
      // a call with no viewer at all is the platform's own system
      // invocation (the one-off post-submit recompute), not a guest —
      // guests and shared viewers arrive with a non-owner viewer and
      // are still blocked. The recompute is idempotent and derives
      // scores purely from the stored comparison history, so a system
      // run can only restore consistency, never invent data.
      if (ctx.viewer && !ctx.viewer.isOwner) return { ok: false, error: OWNER_REQUIRED };
      const db = ctx.db<typeof schema>();
      const latteRows = await db
        .select({
          id: schema.lattes.id,
          artElo: schema.lattes.artElo,
        })
        .from(schema.lattes)
        .orderBy(asc(schema.lattes.id));
      // Chronological replay: oldest comparison first; id breaks ties
      // for comparisons recorded in the same millisecond.
      const comparisons = await db
        .select({
          id: schema.latteComparisons.id,
          winnerId: schema.latteComparisons.winnerId,
          loserId: schema.latteComparisons.loserId,
          winnerEloBefore: schema.latteComparisons.winnerEloBefore,
          winnerEloAfter: schema.latteComparisons.winnerEloAfter,
          loserEloBefore: schema.latteComparisons.loserEloBefore,
          loserEloAfter: schema.latteComparisons.loserEloAfter,
        })
        .from(schema.latteComparisons)
        .orderBy(asc(schema.latteComparisons.createdAt), asc(schema.latteComparisons.id));
      const photoRows = await db.select({ id: schema.lattePhotos.id }).from(schema.lattePhotos);

      // Replay the surviving history exactly as it was played. Each
      // comparison row stores both pours' Elo before and after, so a
      // pour's replay starts from the "before" value in its first
      // surviving matchup — the baseline it held right after the
      // reset, before the re-rank — and accumulates each stored swing
      // (after − before) in chronological order. The final replayed
      // Elo is therefore the "after" value of the pour's last
      // surviving matchup. Recomputing fresh swings from winner/loser
      // alone would be wrong here: the re-rank was played from those
      // stored starting scores, not from a single uniform value.
      // Pours with no surviving matchups keep their current score.
      const eloById = new Map<number, number>();
      for (const row of latteRows) eloById.set(row.id, row.artElo);
      const seen = new Set<number>();
      for (const comparison of comparisons) {
        if (!seen.has(comparison.winnerId)) {
          seen.add(comparison.winnerId);
          eloById.set(comparison.winnerId, comparison.winnerEloBefore);
        }
        if (!seen.has(comparison.loserId)) {
          seen.add(comparison.loserId);
          eloById.set(comparison.loserId, comparison.loserEloBefore);
        }
        const winnerElo = eloById.get(comparison.winnerId);
        const loserElo = eloById.get(comparison.loserId);
        if (winnerElo === undefined || loserElo === undefined) continue;
        eloById.set(
          comparison.winnerId,
          winnerElo + (comparison.winnerEloAfter - comparison.winnerEloBefore),
        );
        eloById.set(
          comparison.loserId,
          loserElo + (comparison.loserEloAfter - comparison.loserEloBefore),
        );
      }

      const results: {
        id: number;
        beforeScore: number;
        afterScore: number;
        beforeElo: number;
        afterElo: number;
        changed: boolean;
      }[] = [];
      let changedCount = 0;
      for (const row of latteRows) {
        const afterElo = eloById.get(row.id) ?? row.artElo;
        const changed = afterElo !== row.artElo;
        if (changed) {
          changedCount += 1;
          // Only the internal Elo (and therefore the derived 0–10
          // score) is written. Win/loss/comparison counters and the
          // comparison history rows are deliberately left untouched.
          await db
            .update(schema.lattes)
            .set({ artElo: afterElo })
            .where(eq(schema.lattes.id, row.id));
        }
        results.push({
          id: row.id,
          beforeScore: eloToScore(row.artElo),
          afterScore: eloToScore(afterElo),
          beforeElo: row.artElo,
          afterElo,
          changed,
        });
      }
      if (changedCount > 0) ctx.invalidateQueries();
      const scoreFor = (id: number) => results.find((r) => r.id === id)?.afterScore;
      return {
        ok: true,
        totalLattes: latteRows.length,
        totalPhotos: photoRows.length,
        totalComparisons: comparisons.length,
        changedCount,
        results,
        score6: scoreFor(6),
        score11: scoreFor(11),
      };
    },
  }),

  resetArtRankings: defineAction({
    description: "Reset all latte-art scores back to the 5.0 baseline and clear comparison history, so the journal can be reranked from scratch.",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      count: z.number().optional(),
      error: z.string().optional(),
    }),
    async handler(ctx) {
      if (!isOwner(ctx)) return { ok: false, error: OWNER_REQUIRED };
      const db = ctx.db<typeof schema>();
      const rows = await db.select({ id: schema.lattes.id }).from(schema.lattes);
      await db.delete(schema.latteComparisons);
      for (const row of rows) {
        await db
          .update(schema.lattes)
          .set({ artElo: 1500, artWins: 0, artLosses: 0, artComparisons: 0 })
          .where(eq(schema.lattes.id, row.id));
      }
      ctx.invalidateQueries();
      return { ok: true, count: rows.length };
    },
  }),

  importLegacyLatte: defineAction({
    description: "Import the one legacy latte entry (October 15, 2026) from the previous tracker, including its photo, if it is not already present.",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      id: z.number(),
      imported: z.boolean(),
    }),
    privileged: [privileged.readLegacyLattePhoto],
    async handler(ctx) {
      if (!isOwner(ctx)) return { ok: false, id: 0, imported: false };
      const db = ctx.db<typeof schema>();
      const madeAt = "2026-10-15T15:11:06.000Z";
      const notes = "Texture: 4/5";
      const existing = await db
        .select({ id: schema.lattes.id })
        .from(schema.lattes)
        .where(
          and(
            eq(schema.lattes.madeAt, madeAt),
            eq(schema.lattes.milk, "Whole milk"),
            eq(schema.lattes.espressoQuality, 4),
            eq(schema.lattes.overallQuality, 4),
            eq(schema.lattes.notes, notes),
          ),
        )
        .limit(1);
      const existingRow = existing[0];
      if (existingRow) return { ok: true, id: existingRow.id, imported: false };

      const photo = await ctx.executePrivileged(privileged.readLegacyLattePhoto, {});
      const blobKey = "latte-photos/migrated-from-latte-tracker-entry-1.jpg";
      await ctx.blobs.put(blobKey, Buffer.from(photo.dataBase64, "base64"), {
        contentType: photo.mimeType,
      });

      try {
        const insertedRows = await db
          .insert(schema.lattes)
          .values({
            madeAt,
            location: null,
            milk: "Whole milk",
            espressoQuality: 4,
            overallQuality: 4,
            latteArtQuality: null,
            notes,
            createdAt: new Date("2026-10-15T15:11:33.890Z"),
          })
          .returning({ id: schema.lattes.id });
        const inserted = insertedRows[0];
        if (!inserted) throw new Error("The legacy entry could not be imported.");
        await db.insert(schema.lattePhotos).values({
          latteId: inserted.id,
          blobKey,
          mimeType: photo.mimeType,
          sortOrder: 0,
        });
        ctx.invalidateQueries();
        return { ok: true, id: inserted.id, imported: true };
      } catch (error) {
        await ctx.blobs.delete(blobKey).catch(() => undefined);
        throw error;
      }
    },
  }),

  deleteLatte: defineAction({
    description: "Delete one latte journal entry along with its photos and art-comparison history.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, error: OWNER_REQUIRED };
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.lattes.id })
        .from(schema.lattes)
        .where(eq(schema.lattes.id, args.id))
        .limit(1);
      if (existing.length === 0) return { ok: false, error: "That entry no longer exists." };
      const photos = await db
        .select({ blobKey: schema.lattePhotos.blobKey })
        .from(schema.lattePhotos)
        .where(eq(schema.lattePhotos.latteId, args.id));
      try {
        // Undo the deleted pour's matchups completely: every comparison
        // involving it is removed, each opponent's win/loss/comparison
        // counters drop by the removed matchups against it, AND each
        // opponent's art score is rolled back by exactly the Elo swing
        // it gained or lost in those matchups. The comparison rows store
        // both pours' Elo before and after, so the opponent's swing is
        // (after − before); subtracting the accumulated swing restores
        // the score the matchup itself changed, without touching swings
        // from the opponent's other matchups or anyone else's scores.
        const comparisons = await db
          .select({
            winnerId: schema.latteComparisons.winnerId,
            loserId: schema.latteComparisons.loserId,
            winnerEloBefore: schema.latteComparisons.winnerEloBefore,
            winnerEloAfter: schema.latteComparisons.winnerEloAfter,
            loserEloBefore: schema.latteComparisons.loserEloBefore,
            loserEloAfter: schema.latteComparisons.loserEloAfter,
          })
          .from(schema.latteComparisons)
          .where(or(eq(schema.latteComparisons.winnerId, args.id), eq(schema.latteComparisons.loserId, args.id)));
        const adjustments = new Map<number, { wins: number; losses: number; comparisons: number; eloSwing: number }>();
        for (const comparison of comparisons) {
          if (comparison.winnerId === args.id) {
            const entry = adjustments.get(comparison.loserId) ?? { wins: 0, losses: 0, comparisons: 0, eloSwing: 0 };
            entry.losses += 1;
            entry.comparisons += 1;
            entry.eloSwing += comparison.loserEloAfter - comparison.loserEloBefore;
            adjustments.set(comparison.loserId, entry);
          } else {
            const entry = adjustments.get(comparison.winnerId) ?? { wins: 0, losses: 0, comparisons: 0, eloSwing: 0 };
            entry.wins += 1;
            entry.comparisons += 1;
            entry.eloSwing += comparison.winnerEloAfter - comparison.winnerEloBefore;
            adjustments.set(comparison.winnerId, entry);
          }
        }
        for (const [opponentId, delta] of adjustments) {
          const opponentRows = await db
            .select({
              artElo: schema.lattes.artElo,
              artWins: schema.lattes.artWins,
              artLosses: schema.lattes.artLosses,
              artComparisons: schema.lattes.artComparisons,
            })
            .from(schema.lattes)
            .where(eq(schema.lattes.id, opponentId))
            .limit(1);
          const opponent = opponentRows[0];
          if (!opponent) continue;
          await db
            .update(schema.lattes)
            .set({
              artElo: opponent.artElo - delta.eloSwing,
              artWins: Math.max(0, opponent.artWins - delta.wins),
              artLosses: Math.max(0, opponent.artLosses - delta.losses),
              artComparisons: Math.max(0, opponent.artComparisons - delta.comparisons),
            })
            .where(eq(schema.lattes.id, opponentId));
        }
        await db
          .delete(schema.latteComparisons)
          .where(or(eq(schema.latteComparisons.winnerId, args.id), eq(schema.latteComparisons.loserId, args.id)));
        await db.delete(schema.lattePhotos).where(eq(schema.lattePhotos.latteId, args.id));
        await db.delete(schema.lattes).where(eq(schema.lattes.id, args.id));
        for (const photo of photos) {
          try {
            await ctx.blobs.delete(photo.blobKey);
          } catch {
            // The entry is already deleted; ignore stale image cleanup failures.
          }
        }
        ctx.invalidateQueries();
        return { ok: true };
      } catch {
        return { ok: false, error: "That entry couldn’t be deleted." };
      }
    },
  }),
} satisfies ActionsModule;
