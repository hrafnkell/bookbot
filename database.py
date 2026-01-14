import sqlite3
from pathlib import Path
from contextlib import contextmanager

DATABASE_FILE = Path("results.db")


def init_database() -> None:
    """Initialize the database and create tables if they don't exist."""
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                line TEXT UNIQUE NOT NULL,
                search_term TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_results_line ON results(line)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_results_search_term ON results(search_term)")
        conn.commit()


@contextmanager
def get_connection():
    """Get a database connection as a context manager."""
    conn = sqlite3.connect(DATABASE_FILE)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def add_results(lines: list[str], search_term: str | None = None) -> int:
    """
    Add lines to the results table. Only lines starting with '!' are added.
    Duplicates are ignored.

    Returns the number of new rows inserted.
    """
    # Filter lines that start with '!'
    valid_lines = [line.strip() for line in lines if line.strip().startswith('!')]

    if not valid_lines:
        return 0

    inserted = 0
    with get_connection() as conn:
        for line in valid_lines:
            try:
                conn.execute(
                    "INSERT INTO results (line, search_term) VALUES (?, ?)",
                    (line, search_term)
                )
                inserted += 1
            except sqlite3.IntegrityError:
                # Duplicate line, skip
                pass
        conn.commit()

    return inserted


def search_results(query: str, limit: int = 100, offset: int = 0) -> tuple[list[dict], int]:
    """
    Search for results matching the query using fuzzy search.

    Splits query into words and matches all words in any order.
    Returns a tuple of (results list, total count).
    """
    # Split query into words for fuzzy matching
    words = query.split()

    if not words:
        return get_all_results(limit, offset)

    # Build WHERE clause that matches all words (fuzzy/any order)
    where_clauses = []
    params = []
    for word in words:
        where_clauses.append("line LIKE ?")
        params.append(f"%{word}%")

    where_sql = " AND ".join(where_clauses)

    with get_connection() as conn:
        # Count total matches
        count_row = conn.execute(
            f"SELECT COUNT(*) as count FROM results WHERE {where_sql}",
            params
        ).fetchone()
        total = count_row["count"] if count_row else 0

        # Get paginated results
        rows = conn.execute(
            f"""
            SELECT id, line, search_term, created_at
            FROM results
            WHERE {where_sql}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset]
        ).fetchall()

        results = [
            {
                "id": row["id"],
                "line": row["line"],
                "search_term": row["search_term"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    return results, total


def get_all_results(limit: int = 100, offset: int = 0) -> tuple[list[dict], int]:
    """
    Get all results with pagination.

    Returns a tuple of (results list, total count).
    """
    with get_connection() as conn:
        count_row = conn.execute("SELECT COUNT(*) as count FROM results").fetchone()
        total = count_row["count"] if count_row else 0

        rows = conn.execute(
            """
            SELECT id, line, search_term, created_at
            FROM results
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset)
        ).fetchall()

        results = [
            {
                "id": row["id"],
                "line": row["line"],
                "search_term": row["search_term"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    return results, total


def import_txt_file(filepath: Path, search_term: str | None = None) -> int:
    """
    Import lines from a txt file into the database.

    Returns the number of new rows inserted.
    """
    if not filepath.exists() or not filepath.is_file():
        return 0

    try:
        text = filepath.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        return add_results(lines, search_term)
    except Exception:
        return 0


def import_results_directory(results_dir: Path) -> int:
    """
    Import all txt files from the results directory into the database.

    Returns the total number of new rows inserted.
    """
    if not results_dir.exists() or not results_dir.is_dir():
        return 0

    total_inserted = 0
    for txt_file in results_dir.rglob("*.txt"):
        # Use parent directory name as search term if available
        search_term = txt_file.parent.name if txt_file.parent != results_dir else None
        inserted = import_txt_file(txt_file, search_term)
        total_inserted += inserted

    return total_inserted


def get_stats() -> dict:
    """Get database statistics."""
    with get_connection() as conn:
        total = conn.execute("SELECT COUNT(*) as count FROM results").fetchone()["count"]
        unique_terms = conn.execute(
            "SELECT COUNT(DISTINCT search_term) as count FROM results WHERE search_term IS NOT NULL"
        ).fetchone()["count"]

    return {
        "total_results": total,
        "unique_search_terms": unique_terms,
    }


def clear_database() -> int:
    """Clear all results from the database. Returns the number of rows deleted."""
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM results")
        deleted = cursor.rowcount
        conn.commit()
    return deleted
