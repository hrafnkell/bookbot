// Config elements
const configCard = document.getElementById('configCard');
const configForm = document.getElementById('configForm');
const configNick = document.getElementById('configNick');
const configUsername = document.getElementById('configUsername');
const configRealname = document.getElementById('configRealname');
const configIdleTimeout = document.getElementById('configIdleTimeout');
const configAutoConnect = document.getElementById('configAutoConnect');
const configError = document.getElementById('configError');
const editConfigBtn = document.getElementById('editConfigBtn');
const cancelConfigBtn = document.getElementById('cancelConfigBtn');
const connectBtn = document.getElementById('connectBtn');
const shutdownBtn = document.getElementById('shutdownBtn');

let editingConfig = false;

const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const searchTermDisplay = document.getElementById('searchTermDisplay');
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const errorDiv = document.getElementById('error');
const progressCard = document.getElementById('progressCard');
const downloadInfo = document.getElementById('downloadInfo');
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
let isConnected = false;
let configExists = false;

// Database search state
let dbCurrentPage = 1;
let dbTotalResults = 0;
let dbCurrentQuery = '';
const dbResultsPerPage = 50;
let dbLastKnownTotal = 0;
let lastStatus = '';

// Files pagination state
let allFiles = [];
let filesCurrentPage = 1;
const filesPerPage = 10;

function updateStatus(data) {
    // Update config and connection state
    configExists = data.config_exists;
    isConnected = data.is_connected;

    // Show/hide config card (show if no config OR editing)
    // Show/hide config card (show if no config OR editing)
    if (!configExists || editingConfig) {
        configCard.classList.remove('hidden');
        // Show cancel button only if we are editing an existing config
        if (configExists) {
            cancelConfigBtn.classList.remove('hidden');
        } else {
            cancelConfigBtn.classList.add('hidden');
        }
    } else {
        configCard.classList.add('hidden');
    }

    // Show/hide edit config button (only show if config exists)
    if (configExists) {
        editConfigBtn.classList.remove('hidden');
    } else {
        editConfigBtn.classList.add('hidden');
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

    // Update progress
    if (data.status === 'downloading' && data.download_progress.filename) {
        progressCard.classList.remove('hidden');
        const progress = data.download_progress;
        const percent = progress.total > 0
            ? Math.round((progress.received / progress.total) * 100)
            : 0;
        downloadInfo.textContent = `${progress.filename} - ${formatBytes(progress.received)} / ${formatBytes(progress.total)}`;
        progressFill.style.width = percent + '%';
    } else {
        progressCard.classList.add('hidden');
    }

    // Update lines - only re-render if lines actually changed
    if (data.status === 'lines_ready' && data.extracted_lines) {
        const linesChanged = JSON.stringify(currentLines) !== JSON.stringify(data.extracted_lines);
        if (linesChanged) {
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
            allFiles = data.files;
            renderFilesList();
        }
    }

    // Auto-refresh database results when new data is added
    // Detect transition from lines_ready (new data just added) to another status
    if (lastStatus === 'lines_ready' && data.status !== 'lines_ready') {
        // New data was just added, refresh the database search
        refreshDbResults();
    }
    lastStatus = data.status;
}

function getFilteredFiles() {
    const searchTerm = fileSearchInput.value.toLowerCase().trim();
    if (!searchTerm) return allFiles;
    return allFiles.filter(f => f.toLowerCase().includes(searchTerm));
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
            `<li class="file-item">
                <a href="/files/download/${encodeURIComponent(f)}" download>${escapeHtml(f)}</a>
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

async function deleteFile(filename) {
    if (!confirm(`Delete ${filename}? This cannot be undone.`)) {
        return;
    }

    try {
        const response = await fetch(`/files/delete/${encodeURIComponent(filename)}`, {
            method: 'DELETE'
        });
        const data = await response.json();

        if (!response.ok) {
            alert(`Error: ${data.error}`);
            return;
        }

        allFiles = allFiles.filter(f => f !== filename);
        renderFilesList();
    } catch (e) {
        alert('Delete request failed');
    }
}

function renderLines(lines) {
    linesContainer.innerHTML = lines.map((line, i) => `
        <div class="line-item">
            <input type="checkbox" id="line-${i + 1}" value="${i + 1}">
            <span class="line-number">${i + 1}</span>
            <span class="line-text">${escapeHtml(line)}</span>
        </div>
    `).join('');
}

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
    return div.innerHTML;
}

async function fetchStatus() {
    try {
        const response = await fetch('/status');
        const data = await response.json();
        updateStatus(data);
    } catch (e) {
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
    const idle_timeout = configIdleTimeout.value.trim();
    const auto_connect = configAutoConnect.checked;

    try {
        const response = await fetch('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nick, username, realname, idle_timeout, auto_connect })
        });
        const data = await response.json();
        if (!response.ok) {
            configError.textContent = data.error;
            configError.classList.remove('hidden');
        } else {
            editingConfig = false;
            fetchStatus();
        }
    } catch (e) {
        configError.textContent = 'Failed to save configuration';
        configError.classList.remove('hidden');
    }
});

// Edit config button handler
editConfigBtn.addEventListener('click', async () => {
    try {
        const response = await fetch('/config');
        const data = await response.json();
        if (data.exists) {
            configNick.value = data.nick || '';
            configUsername.value = data.username || '';
            configRealname.value = data.realname || '';
            configIdleTimeout.value = data.idle_timeout || '20';
            configAutoConnect.checked = data.auto_connect !== false;
        }
    } catch (e) {
        // Ignore errors, just show empty form
    }
    editingConfig = true;
    configCard.classList.remove('hidden');
    configError.classList.add('hidden');
});

// Cancel config button handler
cancelConfigBtn.addEventListener('click', () => {
    editingConfig = false;
    configError.classList.add('hidden');
    fetchStatus();
});

// Connect/disconnect button handler
connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    const endpoint = isConnected ? '/disconnect' : '/connect';

    try {
        const response = await fetch(endpoint, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
            errorDiv.textContent = data.error;
            errorDiv.classList.remove('hidden');
        }
        fetchStatus();
    } catch (e) {
        errorDiv.textContent = 'Connection request failed';
        errorDiv.classList.remove('hidden');
    } finally {
        connectBtn.disabled = false;
    }
});

shutdownBtn.addEventListener('click', async () => {
    if (!confirm('Shut down the IRC bot? This will stop the service.')) {
        return;
    }

    shutdownBtn.disabled = true;
    try {
        const response = await fetch('/shutdown', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
            alert(`Error: ${data.error}`);
            shutdownBtn.disabled = false;
        }
    } catch (e) {
        alert('Shutdown request failed');
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

    errorDiv.classList.add('hidden');
    searchBtn.disabled = true;

    try {
        const formData = new FormData();
        formData.append('term', term);
        const response = await fetch('/search', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!response.ok) {
            errorDiv.textContent = data.error;
            errorDiv.classList.remove('hidden');
        }
    } catch (e) {
        errorDiv.textContent = 'Request failed';
        errorDiv.classList.remove('hidden');
    } finally {
        searchBtn.disabled = false;
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
        alert('Please select at least one item.');
        return;
    }

    downloadSelectedBtn.disabled = true;
    try {
        const response = await fetch('/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ indices })
        });
        const data = await response.json();
        if (!response.ok) {
            errorDiv.textContent = data.error;
            errorDiv.classList.remove('hidden');
        }
    } catch (e) {
        errorDiv.textContent = 'Request failed';
        errorDiv.classList.remove('hidden');
    } finally {
        downloadSelectedBtn.disabled = false;
    }
});

// Poll status every 2 seconds
fetchStatus();
setInterval(fetchStatus, 2000);

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

function renderDbResults(results) {
    if (results.length === 0) {
        dbResultsContainer.innerHTML = '<p class="db-results-empty">No results found.</p>';
        dbResultsActions.classList.add('hidden');
        return;
    }

    dbResultsContainer.innerHTML = results.map((result, i) => `
        <div class="db-result-item">
            <input type="checkbox" id="db-result-${result.id}" data-line="${escapeHtml(result.line)}">
            <span class="db-result-text">${escapeHtml(result.line)}</span>
        </div>
    `).join('');

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

dbDownloadBtn.addEventListener('click', async () => {
    const checkboxes = dbResultsContainer.querySelectorAll('input[type="checkbox"]:checked');
    const lines = Array.from(checkboxes).map(cb => cb.dataset.line);

    if (lines.length === 0) {
        alert('Please select at least one item.');
        return;
    }

    dbDownloadBtn.disabled = true;
    try {
        const response = await fetch('/db/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lines })
        });
        const data = await response.json();
        if (!response.ok) {
            alert(`Error: ${data.error}`);
        } else {
            alert(`Sent ${data.count} items to IRC`);
        }
    } catch (e) {
        alert('Request failed');
    } finally {
        dbDownloadBtn.disabled = false;
    }
});

clearDbBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all saved results? This cannot be undone.')) {
        return;
    }

    clearDbBtn.disabled = true;
    try {
        const response = await fetch('/db/clear', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
            alert(`Error: ${data.error}`);
        } else {
            alert(`Deleted ${data.deleted} results`);
            refreshDbResults();
        }
    } catch (e) {
        alert('Request failed');
    } finally {
        clearDbBtn.disabled = false;
    }
});

// Load database stats and initial results on page load
loadDbStats();
searchDatabase('', 1);
