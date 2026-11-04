import { Database } from "bun:sqlite";

export const DATABASE_FILE = "results.db";

export interface ResultRow {
  id: number;
  line: string;
  search_term: string | null;
  created_at: string;
}

let db: Database | null = null;

export function initDatabase(file: string = DATABASE_FILE): Database {
  if (db) db.close();
  db = new Database(file, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line TEXT UNIQUE NOT NULL,
      search_term TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_results_line ON results(line)");
  db.run("CREATE INDEX IF NOT EXISTS idx_results_search_term ON results(search_term)");
  return db;
}

function conn(): Database {
  if (!db) throw new Error("Database not initialised; call initDatabase() first");
  return db;
}

/** Store lines beginning with '!' (the download commands). Duplicates are ignored. Returns rows inserted. */
export function addResults(lines: string[], searchTerm: string | null = null): number {
  const valid = lines.map((l) => l.trim()).filter((l) => l.startsWith("!"));
  if (valid.length === 0) return 0;

  const database = conn();
  const insert = database.prepare("INSERT OR IGNORE INTO results (line, search_term) VALUES (?, ?)");
  let inserted = 0;
  database.transaction(() => {
    for (const line of valid) {
      inserted += insert.run(line, searchTerm).changes;
    }
  })();
  return inserted;
}

/** Fuzzy search: every whitespace-separated word must appear somewhere in the line, in any order. */
export function searchResults(query: string, limit = 100, offset = 0): { results: ResultRow[]; total: number } {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return getAllResults(limit, offset);

  const where = words.map(() => "line LIKE ?").join(" AND ");
  const params = words.map((w) => `%${w}%`);
  const database = conn();

  const count = database.query<{ count: number }, string[]>(`SELECT COUNT(*) AS count FROM results WHERE ${where}`).get(...params);
  const results = database
    .query<ResultRow, (string | number)[]>(
      `SELECT id, line, search_term, created_at FROM results WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  return { results, total: count?.count ?? 0 };
}

export function getAllResults(limit = 100, offset = 0): { results: ResultRow[]; total: number } {
  const database = conn();
  const count = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM results").get();
  const results = database
    .query<ResultRow, [number, number]>(
      "SELECT id, line, search_term, created_at FROM results ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset);
  return { results, total: count?.count ?? 0 };
}

export function getStats(): { total_results: number; unique_search_terms: number } {
  const database = conn();
  const total = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM results").get();
  const unique = database
    .query<{ count: number }, []>("SELECT COUNT(DISTINCT search_term) AS count FROM results WHERE search_term IS NOT NULL")
    .get();
  return { total_results: total?.count ?? 0, unique_search_terms: unique?.count ?? 0 };
}

export function clearDatabase(): number {
  return conn().run("DELETE FROM results").changes;
}
