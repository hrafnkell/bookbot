// Config elements
const configForm = document.getElementById('configForm');
const configNick = document.getElementById('configNick');
const configUsername = document.getElementById('configUsername');
const configRealname = document.getElementById('configRealname');
const configServer = document.getElementById('configServer');
const configPort = document.getElementById('configPort');
const configChannel = document.getElementById('configChannel');
const configIdleTimeout = document.getElementById('configIdleTimeout');
const configSearchTimeout = document.getElementById('configSearchTimeout');
const configDownloadPath = document.getElementById('configDownloadPath');
const configMaxFileSize = document.getElementById('configMaxFileSize');
const configAutoConnect = document.getElementById('configAutoConnect');
const configError = document.getElementById('configError');
const connectBtn = document.getElementById('connectBtn');
const shutdownBtn = document.getElementById('shutdownBtn');
const banner = document.getElementById('banner');

function dismissBanner() {
    banner.innerHTML = '';
    banner.classList.add('hidden');
}

function showBanner(message, autoDismissMs = 3000) {
    const item = document.createElement('div');
    item.className = 'banner-item';
    item.textContent = message;
    // First message: clear any stale content and show
    if (banner.classList.contains('hidden')) {
        banner.innerHTML = '';
        banner.classList.remove('hidden');
    }
    banner.appendChild(item);
    if (autoDismissMs > 0) {
        setTimeout(dismissBanner, autoDismissMs);
    }
}

function showConfirmBanner(message, onConfirm) {
    const item = document.createElement('div');
    item.className = 'banner-item';
    item.appendChild(document.createTextNode(message));
    const actions = document.createElement('div');
    actions.className = 'banner-actions';
    const yes = document.createElement('button');
    yes.textContent = 'Confirm';
    yes.addEventListener('click', () => { dismissBanner(); onConfirm(); });
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    no.addEventListener('click', dismissBanner);
    actions.appendChild(yes);
    actions.appendChild(no);
    item.appendChild(actions);
    if (banner.classList.contains('hidden')) {
        banner.innerHTML = '';
        banner.classList.remove('hidden');
    }
    banner.appendChild(item);
}

banner.addEventListener('click', (e) => {
    // Dismiss on click, but not if clicking a button inside banner-actions
    if (!e.target.closest('.banner-actions')) {
        dismissBanner();
    }
});

const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const searchTermDisplay = document.getElementById('searchTermDisplay');
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const errorDiv = document.getElementById('error');
const headerProgress = document.getElementById('headerProgress');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');
const linesCard = document.getElementById('linesCard');
const linesContainer = document.getElementById('linesContainer');
const selectAllBtn = document.getElementById('selectAllBtn');
const unselectAllBtn = document.getElementById('unselectAllBtn');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const filesList = document.getElementById('filesList');

// Files list elements
const fileSearchInput = document.getElementById('fileSearchInput');
const fileCount = document.getElementById('fileCount');
const filesPrevBtn = document.getElementById('filesPrevBtn');
const filesNextBtn = document.getElementById('filesNextBtn');
const filesPageInfo = document.getElementById('filesPageInfo');

// Database search elements
const dbStats = document.getElementById('dbStats');
const dbSearchInput = document.getElementById('dbSearchInput');
const clearDbBtn = document.getElementById('clearDbBtn');
const dbResultsContainer = document.getElementById('dbResultsContainer');
const dbResultsActions = document.getElementById('dbResultsActions');
const dbSelectAllBtn = document.getElementById('dbSelectAllBtn');
const dbUnselectAllBtn = document.getElementById('dbUnselectAllBtn');
const dbDownloadBtn = document.getElementById('dbDownloadBtn');
const dbPrevBtn = document.getElementById('dbPrevBtn');
const dbNextBtn = document.getElementById('dbNextBtn');
const dbPageInfo = document.getElementById('dbPageInfo');

let currentLines = [];
let lastStatusData = null;
let lastJoinedKnown = null;
let isConnected = false;
let configExists = null; // null = unknown (initial state)

// Tab switching
const VALID_TABS = ['search', 'downloads', 'saved', 'config', 'log'];

function switchTab(tabName, updateHistory = true) {
    if (!VALID_TABS.includes(tabName)) tabName = 'search';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    document.getElementById('tab-' + tabName).classList.add('active');
    onTabChanged(tabName);
    if (updateHistory) {
        const path = '/' + tabName;
        if (window.location.pathname !== path) {
            history.pushState({ tab: tabName }, '', path);
        }
    }
}

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

window.addEventListener('popstate', () => {
    const path = window.location.pathname.replace(/^\//, '') || 'search';
    switchTab(path, false);
});

// Database search state
let dbCurrentPage = 1;
let dbTotalResults = 0;
let dbCurrentQuery = '';
const dbResultsPerPage = 50;
let dbLastKnownTotal = 0;
let lastStatus = '';

// Files pagination state
let allFiles = [];

// "New file" tracking for the Downloads badge. seenFiles is remembered per browser;
// freshFiles are the ones tagged "New" while the Downloads tab is open.
const SEEN_FILES_KEY = 'ircbook.seenFiles';
const downloadsBadge = document.getElementById('downloadsBadge');
const baseTitle = document.title;
let seenFiles = loadSeenFiles(); // null until the first file list arrives on a fresh browser
let freshFiles = new Set();
let activeTab = null;

function loadSeenFiles() {
    try {
        const raw = localStorage.getItem(SEEN_FILES_KEY);
        return raw ? new Set(JSON.parse(raw)) : null;
    } catch (e) {
        return null;
    }
}

function saveSeenFiles() {
    try {
        localStorage.setItem(SEEN_FILES_KEY, JSON.stringify([...seenFiles]));
    } catch (e) {
        // Private window or storage blocked: the badge still works for this visit.
    }
}

function downloadsInView() {
    return activeTab === 'downloads' && !document.hidden;
}

// Recount unseen files. While the Downloads tab is in view they count as seen
// straight away and get a "New" tag instead of a badge.
function updateDownloadsBadge() {
    if (seenFiles === null) {
        // First visit in this browser: what's already downloaded isn't news.
        seenFiles = new Set(allFiles);
        saveSeenFiles();
    }
    const unseen = allFiles.filter(f => !seenFiles.has(f));
    if (unseen.length > 0 && downloadsInView()) {
        unseen.forEach(f => { seenFiles.add(f); freshFiles.add(f); });
        // Forget deleted files so the stored list doesn't grow forever.
        seenFiles = new Set(allFiles.filter(f => seenFiles.has(f)));
        saveSeenFiles();
        renderFilesList();
    }
    const count = downloadsInView() ? 0 : unseen.length;
    downloadsBadge.textContent = count > 99 ? '99+' : String(count);
    downloadsBadge.classList.toggle('hidden', count === 0);
    downloadsBadge.title = `${count} new file${count === 1 ? '' : 's'}`;
    document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
}

function onTabChanged(tabName) {
    const wasDownloads = activeTab === 'downloads';
    activeTab = tabName;
    if (wasDownloads && tabName !== 'downloads' && freshFiles.size > 0) {
        freshFiles = new Set();
        renderFilesList();
    }
    if (tabName === 'downloads') updateDownloadsBadge();
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateDownloadsBadge();
});
let filesCurrentPage = 1;
const filesPerPage = 10;

function updateStatus(data) {
    lastStatusData = data;
    // Log status changes
    if (lastStatus && lastStatus !== data.status) {
        console.log(`[Status] ${lastStatus} → ${data.status}`);
    }

    // Update config and connection state
    const prevConfigExists = configExists;
    configExists = data.config_exists;
    isConnected = data.is_connected;

    // Auto-switch to config tab on first load if no config exists
    if (!configExists && prevConfigExists === null) {
        switchTab('config');
        loadConfigIntoForm();
    }

    // Update connect button
    if (isConnected) {
        connectBtn.textContent = 'Disconnect';
        connectBtn.className = 'connect-btn disconnect';
    } else {
        connectBtn.textContent = 'Connect';
        connectBtn.className = 'connect-btn connect';
    }
    connectBtn.disabled = !configExists;

    statusIndicator.className = 'status-indicator ' + data.status;

    const statusLabels = {
        'disconnected': 'Disconnected',
        'connected': 'Connected',
        'searching': 'Searching...',
        'downloading': 'Downloading...',
        'lines_ready': 'Results Ready',
        'idle': 'Idle'
    };
    statusText.textContent = statusLabels[data.status] || data.status;

    if (data.search_term) {
        searchTermDisplay.textContent = 'Current search: ' + data.search_term;
    } else {
        searchTermDisplay.textContent = '';
    }

    // Update search button - disable if not connected or downloading
    searchBtn.disabled = !isConnected || data.status === 'downloading';

    // Update error
    if (data.error) {
        errorDiv.textContent = data.error;
        errorDiv.classList.remove('hidden');
    } else {
        errorDiv.classList.add('hidden');
    }

    // Update progress in header
    if (data.status === 'downloading' && data.download_progress.filename) {
        headerProgress.classList.remove('hidden');
        const progress = data.download_progress;
        const percent = progress.total > 0
            ? Math.round((progress.received / progress.total) * 100)
            : 0;
        progressText.textContent = `${progress.filename} ${percent}%`;
        progressFill.style.width = percent + '%';
        // Log download progress at 25% intervals
        if (percent > 0 && percent % 25 === 0) {
            console.log(`[Download] ${progress.filename}: ${percent}%`);
        }
    } else {
        headerProgress.classList.add('hidden');
    }

    // Update lines - only re-render if lines actually changed
    if (data.status === 'lines_ready' && data.extracted_lines) {
        const linesChanged = JSON.stringify(currentLines) !== JSON.stringify(data.extracted_lines);
        if (linesChanged) {
            console.log(`[Results] Received ${data.extracted_lines.length} lines`);
            // New results (possibly from a search started in another tab): drop the old filter.
            linesFilterInput.value = '';
            currentLines = data.extracted_lines;
            renderLines(data.extracted_lines);
        }
        linesCard.classList.remove('hidden');
    } else if (data.status !== 'lines_ready') {
        linesCard.classList.add('hidden');
        currentLines = [];
    }

    // Update files list - only update if files changed
    if (data.files) {
        const filesChanged = JSON.stringify(allFiles) !== JSON.stringify(data.files);
        if (filesChanged) {
            // Log new files
            const newFiles = data.files.filter(f => !allFiles.includes(f));
            if (newFiles.length > 0) {
                console.log(`[Files] New file(s): ${newFiles.join(', ')}`);
            }
            allFiles = data.files;
            renderFilesList();
            updateDownloadsBadge();
        }
    }

    // Auto-refresh database results when new data is added
    // Detect transition from lines_ready (new data just added) to another status
    if (lastStatus === 'lines_ready' && data.status !== 'lines_ready') {
        // New data was just added, refresh the database search
        console.log('[Database] Auto-refreshing after new data added');
        refreshDbResults();
    }
    lastStatus = data.status;
    updateCachedCard();
    if (lastJoinedKnown !== null && lastJoinedKnown !== isConnected) refreshNickPresence();
    lastJoinedKnown = isConnected;
}

function getFilteredFiles() {
    const searchTerm = fileSearchInput.value.toLowerCase().trim();
    const matches = searchTerm ? allFiles.filter(f => f.toLowerCase().includes(searchTerm)) : allFiles;
    // Newly downloaded files go to the top so they aren't lost on a later page.
    return [...matches.filter(f => freshFiles.has(f)), ...matches.filter(f => !freshFiles.has(f))];
}

function renderFilesList() {
    const filtered = getFilteredFiles();
    const totalPages = Math.max(1, Math.ceil(filtered.length / filesPerPage));

    // Adjust current page if needed
    if (filesCurrentPage > totalPages) {
        filesCurrentPage = totalPages;
    }

    const startIdx = (filesCurrentPage - 1) * filesPerPage;
    const endIdx = startIdx + filesPerPage;
    const pageFiles = filtered.slice(startIdx, endIdx);

    // Update count
    if (filtered.length === 0) {
        fileCount.textContent = allFiles.length > 0 ? 'No matching files' : '';
    } else if (filtered.length !== allFiles.length) {
        fileCount.textContent = `Showing ${filtered.length} of ${allFiles.length} files`;
    } else {
        fileCount.textContent = `${allFiles.length} file${allFiles.length !== 1 ? 's' : ''}`;
    }

    // Update list
    if (pageFiles.length > 0) {
        filesList.innerHTML = pageFiles.map(f =>
            `<li class="file-item${freshFiles.has(f) ? ' file-new' : ''}">
                <a href="/files/download/${encodeURIComponent(f)}" download>${escapeHtml(f)}</a>
                ${freshFiles.has(f) ? '<span class="new-tag">New</span>' : ''}
                <button class="delete-btn" data-filename="${escapeHtml(f)}" title="Delete file">×</button>
            </li>`
        ).join('');

        // Add delete handlers
        filesList.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteFile(btn.dataset.filename));
        });
    } else {
        filesList.innerHTML = '<li>No files downloaded yet.</li>';
    }

    // Update pagination
    filesPageInfo.textContent = `Page ${filesCurrentPage} of ${totalPages}`;
    filesPrevBtn.disabled = filesCurrentPage <= 1;
    filesNextBtn.disabled = filesCurrentPage >= totalPages;
}

function deleteFile(filename) {
    showConfirmBanner(`Delete ${filename}? This cannot be undone.`, async () => {
        console.log(`[Files] Deleting: ${filename}`);
        try {
            const response = await fetch(`/files/delete/${encodeURIComponent(filename)}`, {
                method: 'DELETE'
            });
            const data = await response.json();

            if (!response.ok) {
                console.error(`[Files] Delete failed: ${data.error}`);
                showBanner(data.error);
                return;
            }

            console.log(`[Files] Deleted: ${filename}`);
            allFiles = allFiles.filter(f => f !== filename);
            freshFiles.delete(filename);
            renderFilesList();
            updateDownloadsBadge();
        } catch (e) {
            console.error('[Files] Delete request failed:', e);
            showBanner('Delete request failed');
        }
    });
}

const linesFilterInput = document.getElementById('linesFilterInput');
const linesCount = document.getElementById('linesCount');

function renderLines(lines) {
    const filter = linesFilterInput.value.toLowerCase().trim();
    const words = filter ? filter.split(/\s+/) : [];
    let shown = 0;
    linesContainer.innerHTML = lines.map((line, i) => {
        const lower = line.toLowerCase();
        const visible = words.every(w => lower.includes(w));
        if (visible) shown++;
        return `
        <label class="line-item${visible ? '' : ' hidden'}">
            <input type="checkbox" id="line-${i + 1}" value="${i + 1}">
            <span class="line-number">${i + 1}</span>
            <span class="line-text">${escapeHtml(line)}</span>
        </label>`;
    }).join('');

    const term = lastStatusData && lastStatusData.search_term ? ` for "${lastStatusData.search_term}"` : '';
    const total = `${lines.length} result${lines.length === 1 ? '' : 's'}`;
    linesCount.textContent = shown === lines.length
        ? `Found ${total}${term}.`
        : `Showing ${shown} of ${total}${term}.`;
}

linesFilterInput.addEventListener('input', () => {
    renderLines(currentLines);
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    // innerHTML leaves quotes alone; escape them too so the result is safe inside attributes.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function fetchStatus() {
    try {
        const response = await fetch('/status');
        const data = await response.json();
        updateStatus(data);
    } catch (e) {
        console.error('[Status] Connection error:', e);
        statusIndicator.className = 'status-indicator disconnected';
        statusText.textContent = 'Connection error';
    }
}

// Config form handler
configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    configError.classList.add('hidden');

    const nick = configNick.value.trim();
    const username = configUsername.value.trim();
    const realname = configRealname.value.trim();
    const server = configServer.value.trim();
    const port = configPort.value.trim();
    const channel = configChannel.value.trim();
    const idle_timeout = configIdleTimeout.value.trim();
    const search_timeout = configSearchTimeout.value.trim();
    const download_path = configDownloadPath.value.trim() || './files';
    const max_file_size_mb = configMaxFileSize.value.trim();
    const auto_connect = configAutoConnect.checked;

    console.log(`[Config] Saving: nick=${nick}, server=${server}:${port}, channel=${channel}`);
    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nick,
                username,
                realname,
                server,
                port,
                channel,
                idle_timeout,
                search_timeout,
                download_path,
                max_file_size_mb,
                auto_connect
            })
        });
        const data = await response.json();
        if (!response.ok) {
            console.error('[Config] Save failed:', data.error);
            configError.textContent = data.error;
            configError.classList.remove('hidden');
        } else {
            console.log('[Config] Saved successfully');
            switchTab('search');
            fetchStatus();
        }
    } catch (e) {
        console.error('[Config] Save request failed:', e);
        configError.textContent = 'Failed to save configuration';
        configError.classList.remove('hidden');
    }
});

async function loadConfigIntoForm() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        if (data.exists) {
            configNick.value = data.nick || '';
            configUsername.value = data.username || '';
            configRealname.value = data.realname || '';
            configServer.value = data.server || 'irc.irchighway.net';
            configPort.value = data.port || '6669';
            configChannel.value = data.channel || '#ebooks';
            configIdleTimeout.value = data.idle_timeout || '20';
            configSearchTimeout.value = data.search_timeout || '60';
            configDownloadPath.value = data.download_path || './files';
            configMaxFileSize.value = data.max_file_size_mb || '50';
            configAutoConnect.checked = data.auto_connect !== false;
        } else {
            // First run: fill empty fields with a random identity and the default settings,
            // but never overwrite what the user has typed.
            const fill = (input, value) => { if (!input.value && value != null) input.value = value; };
            if (data.suggested) {
                fill(configNick, data.suggested.nick);
                fill(configUsername, data.suggested.username);
            }
            fill(configIdleTimeout, data.idle_timeout);
            fill(configSearchTimeout, data.search_timeout);
        }
    } catch (e) {
        // Ignore errors, just show empty form
    }
    configError.classList.add('hidden');
}

// Activate the tab named by the URL path (deep links and reloads), without touching history
switchTab(window.location.pathname.replace(/^\//, '') || 'search', false);

// Load config values when switching to config tab (or on direct visit)
document.querySelector('.tab[data-tab="config"]').addEventListener('click', loadConfigIntoForm);
if (document.getElementById('tab-config').classList.contains('active')) {
    loadConfigIntoForm();
}

// Connect/disconnect button handler
connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    const endpoint = isConnected ? '/disconnect' : '/connect';
    const action = isConnected ? 'Disconnecting' : 'Connecting';

    console.log(`[IRC] ${action}...`);
    try {
        const response = await fetch(endpoint, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
            console.error(`[IRC] ${action} failed:`, data.error);
            errorDiv.textContent = data.error;
            errorDiv.classList.remove('hidden');
        } else {
            console.log(`[IRC] ${action} successful`);
        }
        fetchStatus();
    } catch (e) {
        console.error(`[IRC] ${action} request failed:`, e);
        errorDiv.textContent = 'Connection request failed';
        errorDiv.classList.remove('hidden');
    } finally {
        connectBtn.disabled = false;
    }
});

shutdownBtn.addEventListener('click', async () => {
    console.log('[System] Shutting down...');
    shutdownBtn.disabled = true;
    try {
        const response = await fetch('/shutdown', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
            console.error('[System] Shutdown failed:', data.error);
            shutdownBtn.disabled = false;
        } else {
            console.log('[System] Shutdown initiated');
        }
    } catch (e) {
        console.error('[System] Shutdown request failed:', e);
        shutdownBtn.disabled = false;
    }
});

// File search and pagination event listeners
fileSearchInput.addEventListener('input', () => {
    filesCurrentPage = 1;
    renderFilesList();
});

filesPrevBtn.addEventListener('click', () => {
    if (filesCurrentPage > 1) {
        filesCurrentPage--;
        renderFilesList();
    }
});

filesNextBtn.addEventListener('click', () => {
    const filtered = getFilteredFiles();
    const totalPages = Math.ceil(filtered.length / filesPerPage);
    if (filesCurrentPage < totalPages) {
        filesCurrentPage++;
        renderFilesList();
    }
});

searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = searchInput.value.trim();
    if (!term) return;

    console.log(`[Search] Searching IRC for: "${term}"`);
    // The old filter was for the previous results; start the new ones unfiltered.
    linesFilterInput.value = '';
    errorDiv.classList.add('hidden');
    searchBtn.disabled = true;

    try {
        const formData = new FormData();
        formData.append('term', term);
        const response = await fetch('/api/search', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!response.ok) {
            console.error('[Search] Failed:', data.error);
            errorDiv.textContent = data.error;
            errorDiv.classList.remove('hidden');
        } else {
            console.log('[Search] Request sent to IRC');
        }
    } catch (e) {
        console.error('[Search] Request failed:', e);
        errorDiv.textContent = 'Request failed';
        errorDiv.classList.remove('hidden');
    } finally {
        setTimeout(() => { searchBtn.disabled = false; }, 5000);
    }
});

selectAllBtn.addEventListener('click', () => {
    const checkboxes = linesContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
});

unselectAllBtn.addEventListener('click', () => {
    const checkboxes = linesContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
});

downloadSelectedBtn.addEventListener('click', async () => {
    const checkboxes = linesContainer.querySelectorAll('input[type="checkbox"]:checked');
    const indices = Array.from(checkboxes).map(cb => parseInt(cb.value));

    if (indices.length === 0) {
        showBanner('Please select at least one item.');
        return;
    }

    console.log(`[Download] Requesting ${indices.length} item(s) from search results`);
    downloadSelectedBtn.disabled = true;
    try {
        const response = await fetch('/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ indices })
        });
        const data = await response.json();
        if (!response.ok) {
            console.error('[Download] Failed:', data.error);
            errorDiv.textContent = data.error;
            errorDiv.classList.remove('hidden');
        } else {
            console.log(`[Download] Sent ${indices.length} request(s) to IRC`);
            showBanner(`Queued ${indices.length} item${indices.length !== 1 ? 's' : ''} for download`);
        }
    } catch (e) {
        console.error('[Download] Request failed:', e);
        errorDiv.textContent = 'Request failed';
        errorDiv.classList.remove('hidden');
    } finally {
        downloadSelectedBtn.disabled = false;
    }
});

// Poll status every 2 seconds
fetchStatus();
setInterval(fetchStatus, 2000);

// Activity log tab: tails the server's log buffer so IRC events, downloads and
// errors can be followed from the browser instead of the terminal.
const logContainer = document.getElementById('logContainer');
const logEmpty = document.getElementById('logEmpty');
const logFilterInput = document.getElementById('logFilterInput');
const logShowDebug = document.getElementById('logShowDebug');
const logAutoScroll = document.getElementById('logAutoScroll');
const logClearBtn = document.getElementById('logClearBtn');
const LOG_MAX_ENTRIES = 500;

let logEntries = [];
let logLastId = 0;
let logFetchInFlight = false;

function formatLogTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logEntryVisible(entry) {
    if (entry.level === 'debug' && !logShowDebug.checked) return false;
    const filter = logFilterInput.value.toLowerCase().trim();
    if (!filter) return true;
    const haystack = `${entry.level} ${entry.message}`.toLowerCase();
    return filter.split(/\s+/).every(w => haystack.includes(w));
}

function isScrolledToBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
}

function renderLogEntry(entry) {
    const line = document.createElement('div');
    line.className = `log-line ${entry.level}`;
    line.dataset.id = entry.id;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatLogTime(entry.ts);
    time.title = new Date(entry.ts).toLocaleString();
    const level = document.createElement('span');
    level.className = 'log-level';
    level.textContent = entry.level.toUpperCase();
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = entry.message;
    line.append(time, level, msg);
    return line;
}

function renderLog() {
    const stick = logAutoScroll.checked || isScrolledToBottom(logContainer);
    const visible = logEntries.filter(logEntryVisible);
    logContainer.replaceChildren(...visible.map(renderLogEntry));
    if (visible.length === 0) {
        logEmpty.textContent = logEntries.length ? 'No entries match the filter.' : 'No log entries yet.';
        logContainer.appendChild(logEmpty);
    }
    if (stick) logContainer.scrollTop = logContainer.scrollHeight;
}

function appendLogEntries(entries) {
    const stick = logAutoScroll.checked || isScrolledToBottom(logContainer);
    const wasEmpty = logContainer.contains(logEmpty) && logEntries.length === 0;
    for (const entry of entries) {
        logEntries.push(entry);
        if (logEntryVisible(entry)) {
            if (logContainer.contains(logEmpty)) logEmpty.remove();
            logContainer.appendChild(renderLogEntry(entry));
        }
    }
    if (logEntries.length > LOG_MAX_ENTRIES) {
        logEntries = logEntries.slice(-LOG_MAX_ENTRIES);
        while (logContainer.children.length > LOG_MAX_ENTRIES) logContainer.firstChild.remove();
    }
    if (wasEmpty && logContainer.children.length === 0) logContainer.appendChild(logEmpty);
    if (stick) logContainer.scrollTop = logContainer.scrollHeight;
}

async function fetchLog() {
    if (logFetchInFlight) return;
    logFetchInFlight = true;
    try {
        const response = await fetch(`/api/log?after=${logLastId}`);
        if (!response.ok) return;
        const data = await response.json();
        if (data.entries.length > 0) {
            appendLogEntries(data.entries);
            logLastId = data.last_id;
        }
    } catch (e) {
        // Server unreachable; the status poller already reports that.
    } finally {
        logFetchInFlight = false;
    }
}

logFilterInput.addEventListener('input', renderLog);
logShowDebug.addEventListener('change', renderLog);
logClearBtn.addEventListener('click', () => {
    logEntries = [];
    renderLog();
});
// Scrolling away from the bottom pauses following; scrolling back down resumes it.
logContainer.addEventListener('scroll', () => {
    logAutoScroll.checked = isScrolledToBottom(logContainer);
});

fetchLog();
setInterval(fetchLog, 2000);

// Database search functions
async function loadDbStats() {
    try {
        const response = await fetch('/db/stats');
        const data = await response.json();
        dbStats.textContent = `${data.total_results} saved results from ${data.unique_search_terms} searches`;
        dbLastKnownTotal = data.total_results;
    } catch (e) {
        dbStats.textContent = '';
    }
}

function refreshDbResults() {
    // Refresh current search results (stats will be updated via searchDatabase)
    searchDatabase(dbCurrentQuery, dbCurrentPage);
}

async function searchDatabase(query = '', page = 1) {
    dbCurrentQuery = query;
    dbCurrentPage = page;
    const offset = (page - 1) * dbResultsPerPage;

    try {
        const params = new URLSearchParams({
            q: query,
            limit: dbResultsPerPage.toString(),
            offset: offset.toString()
        });
        const response = await fetch(`/db/search?${params}`);
        const data = await response.json();

        if (!response.ok) {
            dbResultsContainer.innerHTML = `<p class="db-results-empty">Error: ${escapeHtml(data.error)}</p>`;
            return;
        }

        dbTotalResults = data.total;
        renderDbResults(data.results);
        updateDbPagination();
        loadDbStats();
    } catch (e) {
        dbResultsContainer.innerHTML = '<p class="db-results-empty">Failed to search database</p>';
    }
}

// Colour class for a nick: green when in the channel, red when not, plain when unknown (not connected).
function nickClass(inChannel) {
    if (inChannel === true) return 'nick nick-in';
    if (inChannel === false) return 'nick nick-out';
    return 'nick nick-unknown';
}

function nickTitle(inChannel) {
    if (inChannel === true) return 'In channel';
    if (inChannel === false) return 'Not in channel';
    return 'Connect to see who is in the channel';
}

// One saved result row. The leading "!nick" is wrapped so its colour can be updated in place.
function savedResultRow(result, idPrefix) {
    const match = result.nick ? result.line.match(/^(!\S+)([\s\S]*)$/) : null;
    const text = match
        ? `<span class="${nickClass(result.in_channel)}" data-nick="${escapeHtml(result.nick)}" title="${nickTitle(result.in_channel)}">${escapeHtml(match[1])}</span>${escapeHtml(match[2])}`
        : escapeHtml(result.line);
    return `
        <label class="db-result-item">
            <input type="checkbox" id="${idPrefix}-${result.id}" data-line="${escapeHtml(result.line)}">
            <span class="db-result-text">${text}</span>
        </label>`;
}

function renderDbResults(results) {
    if (results.length === 0) {
        dbResultsContainer.innerHTML = '<p class="db-results-empty">No results found.</p>';
        dbResultsActions.classList.add('hidden');
        return;
    }

    dbResultsContainer.innerHTML = results.map(r => savedResultRow(r, 'db-result')).join('');
    dbResultsActions.classList.remove('hidden');
}

function updateDbPagination() {
    const totalPages = Math.max(1, Math.ceil(dbTotalResults / dbResultsPerPage));
    dbPageInfo.textContent = `Page ${dbCurrentPage} of ${totalPages} (${dbTotalResults} results)`;
    dbPrevBtn.disabled = dbCurrentPage <= 1;
    dbNextBtn.disabled = dbCurrentPage >= totalPages;
}

// Database search event listeners
let dbSearchTimeout = null;
dbSearchInput.addEventListener('input', () => {
    clearTimeout(dbSearchTimeout);
    dbSearchTimeout = setTimeout(() => {
        searchDatabase(dbSearchInput.value.trim(), 1);
    }, 300);
});

dbPrevBtn.addEventListener('click', () => {
    if (dbCurrentPage > 1) {
        searchDatabase(dbCurrentQuery, dbCurrentPage - 1);
    }
});

dbNextBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(dbTotalResults / dbResultsPerPage);
    if (dbCurrentPage < totalPages) {
        searchDatabase(dbCurrentQuery, dbCurrentPage + 1);
    }
});

dbSelectAllBtn.addEventListener('click', () => {
    const checkboxes = dbResultsContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
});

dbUnselectAllBtn.addEventListener('click', () => {
    const checkboxes = dbResultsContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
});

async function downloadSavedLines(container, button) {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
    const lines = Array.from(checkboxes).map(cb => cb.dataset.line);

    if (lines.length === 0) {
        showBanner('Please select at least one item.');
        return;
    }

    console.log(`[Database] Requesting ${lines.length} item(s) from saved results`);
    button.disabled = true;
    try {
        const response = await fetch('/db/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lines })
        });
        const data = await response.json();
        if (!response.ok) {
            console.error('[Database] Download failed:', data.error);
            showBanner(data.error);
        } else {
            console.log(`[Database] Sent ${data.count} request(s) to IRC`);
            showBanner(`Queued ${data.count} item${data.count !== 1 ? 's' : ''} for download`);
        }
    } catch (e) {
        console.error('[Database] Request failed:', e);
        showBanner('Request failed');
    } finally {
        button.disabled = false;
    }
}

dbDownloadBtn.addEventListener('click', () => downloadSavedLines(dbResultsContainer, dbDownloadBtn));

clearDbBtn.addEventListener('click', () => {
    showConfirmBanner('Are you sure you want to clear all saved results? This cannot be undone.', async () => {
        console.log('[Database] Clearing all results...');
        clearDbBtn.disabled = true;
        try {
            const response = await fetch('/db/clear', { method: 'POST' });
            const data = await response.json();
            if (!response.ok) {
                console.error('[Database] Clear failed:', data.error);
                showBanner(data.error);
            } else {
                console.log(`[Database] Cleared ${data.deleted} results`);
                refreshDbResults();
            }
        } catch (e) {
            console.error('[Database] Clear request failed:', e);
            showBanner('Request failed');
        } finally {
            clearDbBtn.disabled = false;
        }
    });
});

// Search tab: show saved matches while typing. Enter still runs a fresh IRC search.
const cachedCard = document.getElementById('cachedCard');
const cachedHint = document.getElementById('cachedHint');
const cachedResultsContainer = document.getElementById('cachedResultsContainer');
const cachedActions = document.getElementById('cachedActions');
const cachedDownloadBtn = document.getElementById('cachedDownloadBtn');
const cachedOpenSavedBtn = document.getElementById('cachedOpenSavedBtn');
const CACHED_LIMIT = 50;

let cachedQuery = '';
let cachedTotal = 0;
let cachedRequestSeq = 0;
let cachedTypingTimer = null;

async function loadCachedMatches(term) {
    const seq = ++cachedRequestSeq;
    try {
        const params = new URLSearchParams({ q: term, limit: String(CACHED_LIMIT), offset: '0' });
        const response = await fetch(`/db/search?${params}`);
        const data = await response.json();
        if (seq !== cachedRequestSeq) return; // a newer keystroke already won
        if (!response.ok) throw new Error(data.error);
        cachedQuery = term;
        cachedTotal = data.total;
        cachedResultsContainer.innerHTML = data.results.length
            ? data.results.map(r => savedResultRow(r, 'cached-result')).join('')
            : '<p class="db-results-empty">No saved matches.</p>';
        cachedActions.classList.toggle('hidden', data.results.length === 0);
    } catch (e) {
        if (seq !== cachedRequestSeq) return;
        cachedQuery = term;
        cachedTotal = 0;
        cachedResultsContainer.innerHTML = '<p class="db-results-empty">Could not load saved matches.</p>';
        cachedActions.classList.add('hidden');
    }
    updateCachedCard();
}

// Hide the cached card once fresh IRC results for the same term are on screen.
function updateCachedCard() {
    const term = searchInput.value.trim();
    const freshShown = lastStatusData && lastStatusData.status === 'lines_ready'
        && (lastStatusData.search_term || '').toLowerCase() === term.toLowerCase();
    const visible = term !== '' && cachedQuery === term && !freshShown;
    cachedCard.classList.toggle('hidden', !visible);
    if (!visible) return;

    const searching = lastStatusData && lastStatusData.status === 'searching'
        && (lastStatusData.search_term || '').toLowerCase() === term.toLowerCase();
    const count = cachedTotal > CACHED_LIMIT
        ? `Showing ${CACHED_LIMIT} of ${cachedTotal} saved matches.`
        : `${cachedTotal} saved match${cachedTotal === 1 ? '' : 'es'}.`;
    cachedHint.textContent = searching
        ? `${count} Searching IRC for fresh results...`
        : `${count} Press Enter to search IRC for fresh results.`;
}

searchInput.addEventListener('input', () => {
    clearTimeout(cachedTypingTimer);
    const term = searchInput.value.trim();
    if (!term) {
        cachedRequestSeq++;
        cachedQuery = '';
        updateCachedCard();
        return;
    }
    cachedTypingTimer = setTimeout(() => loadCachedMatches(term), 250);
});

cachedDownloadBtn.addEventListener('click', () => downloadSavedLines(cachedResultsContainer, cachedDownloadBtn));

cachedOpenSavedBtn.addEventListener('click', () => {
    dbSearchInput.value = cachedQuery;
    searchDatabase(cachedQuery, 1);
    switchTab('saved');
});

// Keep nick colours current as people join and leave, without re-rendering the lists
// (that would clear checkbox selections).
let presenceInFlight = false;

async function refreshNickPresence() {
    if (presenceInFlight || document.hidden) return;
    const spans = document.querySelectorAll('.tab-panel.active .nick[data-nick]');
    if (spans.length === 0) return;
    const nicks = [...new Set([...spans].map(s => s.dataset.nick))];
    presenceInFlight = true;
    try {
        const response = await fetch('/api/presence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nicks })
        });
        if (!response.ok) return;
        const data = await response.json();
        document.querySelectorAll('.nick[data-nick]').forEach(span => {
            if (!(span.dataset.nick in data.present)) return;
            const inChannel = data.present[span.dataset.nick];
            span.className = nickClass(inChannel);
            span.title = nickTitle(inChannel);
        });
    } catch (e) {
        // Server unreachable; the status poller already reports that.
    } finally {
        presenceInFlight = false;
    }
}

setInterval(refreshNickPresence, 5000);
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', refreshNickPresence));

// Load database stats and initial results on page load
loadDbStats();
searchDatabase('', 1);
