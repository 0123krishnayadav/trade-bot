import { expect, test } from "bun:test";
import { migrate, openDatabase, type Migration } from "../src/store/database";

const migrations: Migration[] = [
  { id: 1, name: "create notes", up: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)" },
  {
    id: 2,
    name: "add tags",
    up: `CREATE TABLE tags (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes(id), tag TEXT NOT NULL);
         CREATE INDEX tags_note_id ON tags(note_id);`,
  },
];

test("applies pending migrations once, in order", () => {
  const db = openDatabase(":memory:");
  expect(migrate(db, migrations)).toEqual([1, 2]);
  expect(migrate(db, migrations)).toEqual([]);
  expect(db.query("SELECT id, name FROM schema_migrations ORDER BY id").all()).toEqual([
    { id: 1, name: "create notes" },
    { id: 2, name: "add tags" },
  ]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'tags_note_id'").get()).toEqual({ name: "tags_note_id" });
});

test("applies only new migrations on an existing database", () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations.slice(0, 1));
  expect(migrate(db, migrations)).toEqual([2]);
});

test("a failing migration is rolled back and not recorded", () => {
  const db = openDatabase(":memory:");
  const broken: Migration[] = [{ id: 1, name: "broken", up: "CREATE TABLE a (id INTEGER); CREATE TABLE oops (" }];
  expect(() => migrate(db, broken)).toThrow();
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 0 });
});

test("rejects out-of-order migration ids", () => {
  const db = openDatabase(":memory:");
  expect(() => migrate(db, [migrations[1]!, migrations[0]!])).toThrow("strictly increasing");
});

test("foreign keys are enforced", () => {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  expect(() => db.run("INSERT INTO tags (note_id, tag) VALUES (99, 'x')")).toThrow();
});
