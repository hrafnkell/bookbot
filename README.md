# IRC Book Search Bot

A web-based IRC bot for searching and downloading books from IRC channels. Features a browser-based interface for searching, selecting results, and managing downloads.

## Requirements

- Python 3.10+

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd ircbot
   ```

2. Create a virtual environment (recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate  # Linux/macOS
   # or
   venv\Scripts\activate     # Windows
   ```

   Or skip the virtual environment and install dependencies directly:
   ```bash
   pip install -r requirements.txt
   ```

3. Install dependencies if you created a virtual environment:
   ```bash
   pip install -r requirements.txt
   ```

## Running

Start the application:
```bash
python main.py
```

The web interface will be available at `http://localhost:8044`.

## Configuration

On first run, you'll need to configure your IRC identity through the web interface:

- **Nickname**: Your IRC nickname
- **Username**: Your IRC username
- **Real Name**: Your IRC real name (can be anything)
- **IRC Server**: Server hostname (default: irc.irchighway.net)
- **IRC Port**: Server port (default: 6669)
- **Channel**: Channel to join (default: #ebooks)
- **Idle Timeout**: Minutes of inactivity before auto-disconnect (default: 20)

The configuration is saved to `irc_config.json` and persists between sessions.

## Usage

1. Open `http://localhost:8044` in your browser
2. Configure your IRC identity (first time only)
3. Click **Connect** to join the IRC channel
4. Enter a search term and click **Search**
5. Select items from the results and click **Download Selected**
6. Downloaded files appear in the "Downloaded Files" section

### Features

- **Search**: Search for books in the IRC channel
- **Download Progress**: Real-time download progress display
- **File Browser**: Browse and download previously saved search results
- **Idle Timeout**: Automatically disconnects from IRC after inactivity
- **Pagination**: Navigate through large file lists

## Project Structure

```
ircbot/
├── main.py           # Application entry point
├── bot.py            # IRC bot implementation
├── web_server.py     # Web server and API routes
├── state.py          # Application state management
├── config.py         # IRC configuration handling
├── requirements.txt  # Python dependencies
├── templates/        # HTML templates
│   └── index.html
├── static/           # Static assets
│   ├── styles.css
│   └── app.js
├── files/            # Downloaded files (created automatically)
└── results/          # Saved search results (created automatically)
```

## Disclaimer

This tool is an IRC client that automates search and DCC file transfers. It is intended for downloading freely available and public domain content. Users are solely responsible for ensuring their use complies with applicable copyright laws. The authors do not condone or encourage copyright infringement.

## License

MIT
