# Changelog

## [Unreleased]

### Added
- **Web-based IRC configuration**: Users can now configure their IRC identity (nickname, username, real name) via the web interface instead of hardcoded values
- **Configurable idle timeout**: Added idle timeout setting (in minutes) that automatically disconnects from IRC after inactivity
- **Connect/disconnect controls**: Added buttons in the web UI to manually connect and disconnect from IRC
- **Static file serving**: Added `/static/` route for serving CSS and JavaScript files

### Changed
- **Frontend refactoring**: Separated inline CSS and JavaScript from `index.html` into `static/styles.css` and `static/app.js`
- **IRC configuration module**: Moved IRC server constants and user config to dedicated `config.py` module
- **Connection management**: Bot wrapper now has explicit `connect()`, `disconnect()`, and `is_connected()` methods instead of auto-connecting on start
- **Activity tracking**: Search and selection actions now update last activity timestamp to reset idle timer

### Fixed
- Search button is now disabled when not connected to IRC
- Added connection state checks before sending messages to IRC
