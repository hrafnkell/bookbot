// Config elements
const configCard = document.getElementById('configCard');
const configForm = document.getElementById('configForm');
const configNick = document.getElementById('configNick');
const configUsername = document.getElementById('configUsername');
const configRealname = document.getElementById('configRealname');
const configIdleTimeout = document.getElementById('configIdleTimeout');
const configError = document.getElementById('configError');
const editConfigBtn = document.getElementById('editConfigBtn');
const cancelConfigBtn = document.getElementById('cancelConfigBtn');
const connectBtn = document.getElementById('connectBtn');

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

// Results browser elements
const breadcrumb = document.getElementById('breadcrumb');
const browserList = document.getElementById('browserList');
const resultFileView = document.getElementById('resultFileView');
const resultFileName = document.getElementById('resultFileName');
const resultLinesContainer = document.getElementById('resultLinesContainer');
const backToBrowserBtn = document.getElementById('backToBrowserBtn');
const resultSelectAllBtn = document.getElementById('resultSelectAllBtn');
const resultUnselectAllBtn = document.getElementById('resultUnselectAllBtn');
const resultDownloadBtn = document.getElementById('resultDownloadBtn');

let currentLines = [];
let currentBrowserPath = '';
let currentResultFile = null;
let isConnected = false;
let configExists = false;
let resultLines = [];

// Files pagination state
let allFiles = [];
let filesCurrentPage = 1;
const filesPerPage = 10;

function updateStatus(data) {
    // Update config and connection state
    configExists = data.config_exists;
    isConnected = data.is_connected;

    // Show/hide config card (show if no config OR editing)
    if (!configExists || editingConfig) {
        configCard.classList.remove('hidden');
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
        connectBtn.style.marginLeft = '10px';
    } else {
        connectBtn.textContent = 'Connect';
        connectBtn.className = 'connect-btn connect';
        connectBtn.style.marginLeft = configExists ? '10px' : 'auto';
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
            `<li><a href="/files/download/${encodeURIComponent(f)}" download>${escapeHtml(f)}</a></li>`
        ).join('');
    } else {
        filesList.innerHTML = '<li>No files downloaded yet.</li>';
    }

    // Update pagination
    filesPageInfo.textContent = `Page ${filesCurrentPage} of ${totalPages}`;
    filesPrevBtn.disabled = filesCurrentPage <= 1;
    filesNextBtn.disabled = filesCurrentPage >= totalPages;
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

    try {
        const response = await fetch('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nick, username, realname, idle_timeout })
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

// Results browser functions
async function loadResultsDirectory(path = '') {
    currentBrowserPath = path;
    try {
        const url = path ? `/results?path=${encodeURIComponent(path)}` : '/results';
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok) {
            browserList.innerHTML = `<li>Error: ${escapeHtml(data.error)}</li>`;
            return;
        }

        updateBreadcrumb(path);

        if (data.items.length === 0) {
            browserList.innerHTML = '<li>Empty directory</li>';
            return;
        }

        browserList.innerHTML = data.items.map(item => {
            const itemPath = path ? `${path}/${item.name}` : item.name;
            const itemClass = item.type === 'dir' ? 'dir' : (item.is_txt ? 'txt' : 'file');
            return `<li class="browser-item ${itemClass}" data-path="${escapeHtml(itemPath)}" data-type="${item.type}" data-txt="${item.is_txt}">${escapeHtml(item.name)}</li>`;
        }).join('');

        // Add click handlers
        browserList.querySelectorAll('.browser-item').forEach(item => {
            item.addEventListener('click', () => {
                const itemPath = item.dataset.path;
                const itemType = item.dataset.type;
                const isTxt = item.dataset.txt === 'true';

                if (itemType === 'dir') {
                    loadResultsDirectory(itemPath);
                } else if (isTxt) {
                    loadResultFile(itemPath);
                }
            });
        });
    } catch (e) {
        browserList.innerHTML = '<li>Failed to load directory</li>';
    }
}

function updateBreadcrumb(path) {
    const parts = path ? path.split('/') : [];
    let html = '<a href="#" data-path="">results</a>';

    let currentPath = '';
    for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        html += ` <span>/</span> <a href="#" data-path="${escapeHtml(currentPath)}">${escapeHtml(part)}</a>`;
    }

    breadcrumb.innerHTML = html;

    // Add click handlers
    breadcrumb.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const linkPath = link.dataset.path;
            resultFileView.classList.add('hidden');
            browserList.classList.remove('hidden');
            loadResultsDirectory(linkPath);
        });
    });
}

async function loadResultFile(path) {
    try {
        const response = await fetch(`/results/read?path=${encodeURIComponent(path)}`);
        const data = await response.json();

        if (!response.ok) {
            alert(`Error: ${data.error}`);
            return;
        }

        currentResultFile = path;
        resultLines = data.lines;

        const fileName = path.split('/').pop();
        resultFileName.textContent = fileName;

        resultLinesContainer.innerHTML = data.lines.map((line, i) => `
            <div class="line-item">
                <input type="checkbox" id="result-line-${i + 1}" value="${i + 1}">
                <span class="line-number">${i + 1}</span>
                <span class="line-text">${escapeHtml(line)}</span>
            </div>
        `).join('');

        browserList.classList.add('hidden');
        resultFileView.classList.remove('hidden');
    } catch (e) {
        alert('Failed to load file');
    }
}

backToBrowserBtn.addEventListener('click', () => {
    resultFileView.classList.add('hidden');
    browserList.classList.remove('hidden');
    currentResultFile = null;
});

resultSelectAllBtn.addEventListener('click', () => {
    const checkboxes = resultLinesContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
});

resultUnselectAllBtn.addEventListener('click', () => {
    const checkboxes = resultLinesContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
});

resultDownloadBtn.addEventListener('click', async () => {
    const checkboxes = resultLinesContainer.querySelectorAll('input[type="checkbox"]:checked');
    const indices = Array.from(checkboxes).map(cb => parseInt(cb.value));

    if (indices.length === 0) {
        alert('Please select at least one item.');
        return;
    }

    if (!currentResultFile) {
        alert('No file selected');
        return;
    }

    resultDownloadBtn.disabled = true;
    try {
        const response = await fetch('/results/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentResultFile, indices })
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
        resultDownloadBtn.disabled = false;
    }
});

// Load results directory on page load
loadResultsDirectory();
