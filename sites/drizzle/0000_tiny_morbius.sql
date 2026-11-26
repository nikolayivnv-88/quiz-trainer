CREATE TABLE `quiz_guard` (
	`id` integer PRIMARY KEY NOT NULL,
	`accepted` integer NOT NULL,
	CONSTRAINT "quiz_guard_accepted" CHECK("quiz_guard"."accepted" = 1)
);
--> statement-breakpoint
CREATE TABLE `quiz_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`imported` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL
);
