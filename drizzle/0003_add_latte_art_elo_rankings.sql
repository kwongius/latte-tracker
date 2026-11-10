ALTER TABLE `lattes` ADD COLUMN `art_elo` integer DEFAULT 1500 NOT NULL;
--> statement-breakpoint
ALTER TABLE `lattes` ADD COLUMN `art_wins` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `lattes` ADD COLUMN `art_losses` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `lattes` ADD COLUMN `art_comparisons` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `lattes` SET `art_elo` = 1500 + (COALESCE(`latte_art_quality`, 3) - 3) * 80 WHERE `latte_art_quality` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `latte_comparisons` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `winner_id` integer NOT NULL,
  `loser_id` integer NOT NULL,
  `winner_elo_before` integer NOT NULL,
  `loser_elo_before` integer NOT NULL,
  `winner_elo_after` integer NOT NULL,
  `loser_elo_after` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`winner_id`) REFERENCES `lattes`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`loser_id`) REFERENCES `lattes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `latte_comparisons_winner_id_idx` ON `latte_comparisons` (`winner_id`);
--> statement-breakpoint
CREATE INDEX `latte_comparisons_loser_id_idx` ON `latte_comparisons` (`loser_id`);
