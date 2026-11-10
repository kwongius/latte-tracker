DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE `lattes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `made_at` text NOT NULL,
  `location` text,
  `milk` text,
  `espresso_quality` integer,
  `overall_quality` integer,
  `latte_art_quality` integer,
  `notes` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `latte_photos` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `latte_id` integer NOT NULL,
  `blob_key` text NOT NULL,
  `mime_type` text NOT NULL,
  `sort_order` integer NOT NULL,
  FOREIGN KEY (`latte_id`) REFERENCES `lattes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `latte_photos_latte_id_idx` ON `latte_photos` (`latte_id`);
