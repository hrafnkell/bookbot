# Changelog

## [2.1.0] - 2026-11-04

### Added
- **Saved matches while typing**: the Search tab shows matching saved results as you type, ready to download; Enter still runs a fresh IRC search.
- **Nick presence colours**: in saved results the serving bot's nick is green when it is in the channel, red when it is not and grey while disconnected. Colours refresh in place via `POST /api/presence`, and `/db/search` results now include `nick` and `in_channel`.
- **Prebuilt Windows executable** on the GitHub release page, with download-and-run instructions in the README. The Windows binary opens the web UI in the browser when started (`IRCBOOK_NO_BROWSER=1` turns this off).
- **Random first-run identity**: before a config is saved, the Config tab is pre-filled with a random nickname and username.
- README screenshots.

### Changed
- **Mobile layout**: the header, tabs, forms, result lists and buttons adapt to phone screens; whole result rows are tappable and inputs no longer trigger zoom on iOS.

### Fixed
- Saving the config on first run failed because the idle and search timeout fields were empty; they are now filled with the defaults.
- Saved result lines containing quotes were truncated when sent for download.

## [2.0.0] - 2026-10-10

### Changed
- **Rewritten in TypeScript on Bun**: replaces Python, aiohttp, jinja2 and irc3 with `Bun.serve`, `bun:sqlite` and irc-framework. No interpreter or virtualenv is needed.
- **Standalone executables**: `bun run build` produces a single binary with the web UI embedded; `bun run build:all` cross-compiles for Linux, macOS and Windows.
- **Data directory**: runtime data stays in the working directory, or in `$IRCBOOK_DATA` when set. `irc_config.json` and `results.db` keep the same format as the Python version.
- **Search endpoint** moved from `POST /search` to `POST /api/search`; `GET /search` now serves the UI like the other tab paths.
- The active tab is selected client-side from the URL instead of being rendered server-side.

### Fixed
- Searches sent immediately after (re)connecting were silently lost: the app now waits until it has joined the channel before sending, and reports an error instead of queueing a message the connection cannot deliver.
- Disconnecting (idle timeout or the Disconnect button) could leave a second, orphaned IRC session holding the nick because the IRC library reconnected on its own. Auto-reconnect is disabled and the old connection is torn down explicitly.
- `DCC SEND` filenames containing spaces or apostrophes are parsed correctly.

### Added
- **Log tab**: the web UI tails the server's activity log (timestamps, levels, filter, follow mode) via `GET /api/log`, so IRC events, search bot replies and transfer errors can be followed without the terminal. Search bot "no matches" notices now end the search with the bot's message instead of a timeout.
- End-to-end test suite that runs a fake IRC server and DCC sender on localhost (`bun test`).

## [Unreleased]

### Added
- **Search timeout**: Configurable timeout (default 60 seconds) that resets status to "connected" with error message if no results are received
- **Console logging**: Added detailed browser console logs for debugging (status changes, searches, downloads, file operations, config saves)
- **DCC debugging**: Added raw message logging and CTCP handler to help diagnose DCC transfer issues
- **SQLite database for search results**: Lines starting with `!` are now stored in a SQLite database (`results.db`) with automatic deduplication
- **Fuzzy search**: Search saved results by multiple words in any order (e.g., "tolkien hobbit epub")
- **Auto-refresh results**: Database search results automatically refresh when new data is added
- **Auto-connect setting**: Option to enable/disable automatic IRC connection on startup
- **Clear database button**: Button to delete all saved results with confirmation dialog
- **Favicon**: Added book icon favicon
- **Web-based IRC configuration**: Users can now configure their IRC identity (nickname, username, real name) via the web interface instead of hardcoded values
- **Configurable idle timeout**: Added idle timeout setting (in minutes) that automatically disconnects from IRC after inactivity
- **Connect/disconnect controls**: Added buttons in the web UI to manually connect and disconnect from IRC
- **Static file serving**: Added `/static/` route for serving CSS and JavaScript files
- **File delete controls**: Added delete buttons with confirmation and API endpoint to remove downloaded files
- **Shutdown control**: Added header button to gracefully stop the service
- **Configurable server details**: Added server, port, and channel fields to IRC configuration

### Changed
- **Results storage**: Replaced file-based results browser with SQLite database search UI
- **Frontend refactoring**: Separated inline CSS and JavaScript from `index.html` into `static/styles.css` and `static/app.js`
- **IRC configuration module**: Moved IRC server constants and user config to dedicated `config.py` module
- **Connection management**: Bot wrapper now has explicit `connect()`, `disconnect()`, and `is_connected()` methods instead of auto-connecting on start
- **Activity tracking**: Search and selection actions now update last activity timestamp to reset idle timer
- **Edit config behavior**: Edit button now toggles the config panel and scrolls to the top

### Fixed
- Search button is now disabled when not connected to IRC
- Added connection state checks before sending messages to IRC
