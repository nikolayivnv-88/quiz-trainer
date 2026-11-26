import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const questions = sqliteTable('quiz_questions', {id:text('id').primaryKey(),state:text('state').notNull()});
export const sessions = sqliteTable('quiz_sessions', {id:text('id').primaryKey(),state:text('state').notNull()});
export const meta = sqliteTable('quiz_meta', {id:integer('id').primaryKey(),revision:integer('revision').notNull().default(0),imported:integer('imported').notNull().default(0)});
// A failed CHECK aborts the complete D1 batch, including any bank changes.
export const guard = sqliteTable('quiz_guard', {id:integer('id').primaryKey(),accepted:integer('accepted').notNull()}, t=>[check('quiz_guard_accepted',sql`${t.accepted} = 1`)]);
