# Changelog

## [Unreleased]

### Added
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
