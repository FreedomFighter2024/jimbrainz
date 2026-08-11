import { init} from './init.js';
import {sleep} from './utils.js';



document.addEventListener('DOMContentLoaded', async () => {
    init({refreshLidarrInfo})
});




const searchCache = {};



function loadAllCoverImages(parentContainer) {
    const imageWrappers = parentContainer.querySelectorAll('.results-box-image-container[data-mbid]');

    imageWrappers.forEach(imageWrapper => {
        const mbid = imageWrapper.getAttribute('data-mbid');
        const thumbUrl = `https://coverartarchive.org/release-group/${mbid}/front-250`;
        const tempImg = new Image();
        tempImg.src = thumbUrl;

        const resultBox = imageWrapper.querySelector('.results-box.release-group-result');
        const initialHeight = resultBox.getBoundingClientRect().height;

        tempImg.decode()
            .then(() => {

                tempImg.style.height = `${initialHeight - 2}px`;
                const imageDiv = document.createElement('div');
                imageDiv.className = 'results-box-image';
                const img = document.createElement('img');
                tempImg.decoding = "sync";
                imageDiv.appendChild(tempImg);
                imageWrapper.prepend(imageDiv);
            })

            .catch((encodingError) => {
                console.warn(`Cover missing or decode failed for ${mbid}`);
            });
    });
}



async function fetchLidarrInfo() {
    console.log("getting lidarr info")
    const response = await fetch(`/lidbrainz/add_to_lidarr/system_info`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to fetch system info');
    }

    return response.json();
}



async function refreshLidarrInfo() {
    console.log("refreshng lidarr info")
    try {
        const lidarrInfo = await fetchLidarrInfo();
        await sleep(100)
        await populateMetadataProfiles(lidarrInfo.metadata_profiles);
        await sleep(150)
        await populateQualityProfiles(lidarrInfo.quality_profiles);
        await sleep(150)
        await populateFolderProfiles(lidarrInfo.root_folders);
        return lidarrInfo.lidarr_url;
    }

    catch (error) {}
}



/* ===== persisted "default download profile" ===== */

const DOWNLOAD_DEFAULTS_STORAGE_KEY = 'jimbrainz-download-defaults';

function loadDownloadDefaults() {
    try {
        const saved = JSON.parse(localStorage.getItem(DOWNLOAD_DEFAULTS_STORAGE_KEY));
        return saved && typeof saved === 'object' ? saved : {};
    }

    catch {
        return {};
    }
}

function saveDownloadDefaults(partial) {
    Object.assign(downloadDefaults, partial);

    try {
        localStorage.setItem(DOWNLOAD_DEFAULTS_STORAGE_KEY, JSON.stringify(downloadDefaults));
    }

    catch {
        // storage unavailable (private browsing, quota, etc) - just skip persisting
    }
}

let downloadDefaults = loadDownloadDefaults();

function updateAccordionValueLabel(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = text || '—';
}

function closeAccordionRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) row.classList.remove('open');
}

function setupAccordion() {
    const rows = document.querySelectorAll('#download-profile .accordion-row');

    rows.forEach(row => {
        const header = row.querySelector('.accordion-row-header');
        header.addEventListener('click', () => {
            const wasOpen = row.classList.contains('open');
            rows.forEach(r => r.classList.remove('open'));
            if (!wasOpen) row.classList.add('open');
        });
    });
}
setupAccordion();

const autoDownloadCheckbox = document.getElementById('auto-download-checkbox');
if (typeof downloadDefaults.autoDownload === 'boolean') {
    autoDownloadCheckbox.checked = downloadDefaults.autoDownload;
}
autoDownloadCheckbox.addEventListener('change', () => {
    saveDownloadDefaults({ autoDownload: autoDownloadCheckbox.checked });
});



async function populateMetadataProfiles(profiles) {
    console.log("populating metadata profs")
    const container = document.getElementById('metadata-profile-select');
    container.innerHTML = '';

    const savedId = downloadDefaults.metadataProfileId;
    const savedExists = profiles.some(p => p.id === savedId);
    const selectedId = savedExists ? savedId : profiles[0]?.id;

    profiles.forEach(profile => {
        const metadataProfileElementId = `metadata-profile-${profile.id}`;
        container.innerHTML +=
        `
            <input type="radio" id="${metadataProfileElementId}" name="metadata-profile" value="${profile.id}" ${profile.id === selectedId ? 'checked' : ''}>
            <label for="${metadataProfileElementId}">└─╲ ${profile.name}</label>
        `;
    });

    updateAccordionValueLabel('metadata-profile-current', profiles.find(p => p.id === selectedId)?.name);

    container.addEventListener('change', () => {
        const checked = document.querySelector('#metadata-profile-select > input[type="radio"]:checked');
        if (!checked) return;
        const profile = profiles.find(p => String(p.id) === checked.value);
        updateAccordionValueLabel('metadata-profile-current', profile?.name);
        saveDownloadDefaults({ metadataProfileId: profile ? profile.id : checked.value });
        closeAccordionRow('metadata-accordion-row');
    });
}



async function populateQualityProfiles(profiles) {
    console.log("populating quality profs")
    const container = document.getElementById('quality-profile-select');
    container.innerHTML = '';

    const savedId = downloadDefaults.qualityProfileId;
    const savedExists = profiles.some(p => p.id === savedId);
    const selectedId = savedExists ? savedId : profiles[0]?.id;

    profiles.forEach(profile => {
        const qualityProfileElementId = `quality-profile-${profile.id}`;
        container.innerHTML +=
        `
            <input type="radio" id="${qualityProfileElementId}" name="quality-profile" value="${profile.id}" ${profile.id === selectedId ? 'checked' : ''}>
            <label for="${qualityProfileElementId}">└─╲ ${profile.name}</label>
        `;
    });

    updateAccordionValueLabel('quality-profile-current', profiles.find(p => p.id === selectedId)?.name);

    container.addEventListener('change', () => {
        const checked = document.querySelector('#quality-profile-select > input[type="radio"]:checked');
        if (!checked) return;
        const profile = profiles.find(p => String(p.id) === checked.value);
        updateAccordionValueLabel('quality-profile-current', profile?.name);
        saveDownloadDefaults({ qualityProfileId: profile ? profile.id : checked.value });
        closeAccordionRow('quality-accordion-row');
    });
}



async function populateFolderProfiles(profiles) {
    console.log("populating folders")
    const container = document.getElementById('folder-profile-select');
    container.innerHTML = '';

    const savedPath = downloadDefaults.folderPath;
    const savedExists = profiles.some(p => p.path === savedPath);
    const selectedPath = savedExists ? savedPath : profiles[0]?.path;

    profiles.forEach(profile => {
        const folderProfileElementId = `folder-profile-${profile.id}`;
        container.innerHTML +=
        `
            <input type="radio" id="${folderProfileElementId}" name="folder-profile" value="${profile.path}" ${profile.path === selectedPath ? 'checked' : ''}>
            <label for="${folderProfileElementId}">└─╲ ${profile.name}</label>
        `;
    });

    updateAccordionValueLabel('folder-profile-current', profiles.find(p => p.path === selectedPath)?.name);

    container.addEventListener('change', () => {
        const checked = document.querySelector('#folder-profile-select > input[type="radio"]:checked');
        if (!checked) return;
        const profile = profiles.find(p => p.path === checked.value);
        updateAccordionValueLabel('folder-profile-current', profile?.name);
        saveDownloadDefaults({ folderPath: checked.value });
        closeAccordionRow('folder-accordion-row');
    });
}



function getSettings() {
    const metadataProfileId = document.querySelector('#metadata-profile-select > input[type="radio"]:checked').value;
    const qualityProfileId = document.querySelector('#quality-profile-select > input[type="radio"]:checked').value;
    const folderPath = document.querySelector('#folder-profile-select > input[type="radio"]:checked').value;
    const autoDownload = document.getElementById('auto-download-checkbox').checked;
    const settings = {
        metadataProfileId,
        qualityProfileId,
        folderPath,
        autoDownload
    };
    return settings
}



function checkScrollability() {
    const resultsContainer = document.getElementById("search-results-scrollable")
    const logsContainer = document.getElementById("logs-scrollable")

    if (resultsContainer.scrollHeight > resultsContainer.clientHeight) {
        resultsContainer.classList.add('is-scrollable');
    }

    else {
        resultsContainer.classList.remove('is-scrollable');
    }

    if (logsContainer.scrollHeight > logsContainer.clientHeight) {
        logsContainer.classList.add('is-scrollable');
    }

    else {
        logsContainer.classList.remove('is-scrollable');
    }
}
window.addEventListener('resize', checkScrollability);
checkScrollability();



/* ===== floating log window ===== */

const LOG_STATE_STORAGE_KEY = 'jimbrainz-log-open';
const logWindow = document.getElementById('log-window');
const logToggleButton = document.getElementById('log-toggle-button');
const logCloseButton = document.getElementById('log-close-button');
const logUnreadBadge = document.getElementById('log-unread-badge');
let unreadLogCount = 0;

function setLogOpen(open) {
    logWindow.classList.toggle('open', open);

    try {
        localStorage.setItem(LOG_STATE_STORAGE_KEY, open ? '1' : '0');
    }

    catch {
        // storage unavailable - skip persisting
    }

    if (open) {
        unreadLogCount = 0;
        logUnreadBadge.hidden = true;
        logUnreadBadge.textContent = '0';
        checkScrollability();
    }
}

function isLogOpenSaved() {
    try {
        return localStorage.getItem(LOG_STATE_STORAGE_KEY) === '1';
    }

    catch {
        return false;
    }
}

setLogOpen(isLogOpenSaved());

logToggleButton.addEventListener('click', () => {
    setLogOpen(!logWindow.classList.contains('open'));
});
logCloseButton.addEventListener('click', () => setLogOpen(false));

document.addEventListener('click', (e) => {
    if (logWindow.classList.contains('open') && !logWindow.contains(e.target) && !logToggleButton.contains(e.target)) {
        setLogOpen(false);
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && logWindow.classList.contains('open')) setLogOpen(false);
});

const logObserver = new MutationObserver((mutations) => {
    if (logWindow.classList.contains('open')) return;

    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const type = node.querySelector('.event-type');

            if (type && (type.classList.contains('WARNING') || type.classList.contains('ERROR'))) {
                unreadLogCount += 1;
            }
        }
    }

    if (unreadLogCount > 0) {
        logUnreadBadge.hidden = false;
        logUnreadBadge.textContent = unreadLogCount > 99 ? '99+' : String(unreadLogCount);
    }
});
logObserver.observe(document.getElementById('logs-scrollable'), { childList: true });



const confirmSearchButton = document.getElementById('search-input-button');
const releaseSearchInput = document.getElementById('release-search-input');
const artistSearchInput = document.getElementById('artist-search-input');
const incresaeLimitButton = document.getElementById('limit-increase');
const decreaseLimitButton = document.getElementById('limit-decrease');
const limitValueDisplay = document.getElementById('limit-value');



incresaeLimitButton.addEventListener('click', () => {
    let currentLimit = parseInt(limitValueDisplay.innerText);

    if (currentLimit < 100) {
        currentLimit += 1;
        limitValueDisplay.innerText = currentLimit.toString();
    }
});



decreaseLimitButton.addEventListener('click', () => {
    let currentLimit = parseInt(limitValueDisplay.innerText);

    if (currentLimit > 1) {
        currentLimit -= 1;
        limitValueDisplay.innerText = currentLimit.toString();
    }
});



async function searchReleaseGroups(query) {
    const params = new URLSearchParams({
        query: query,
        limit: parseInt(limitValueDisplay.innerText)
    });

    const response = await fetch(`/lidbrainz/search_musicbrainz/fully_search?${params}`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Search failed');
    }

    return response.json();
}



async function fetchReleases(releaseGroupMbid) {
    const params = new URLSearchParams({
        release_group_mbid: releaseGroupMbid
    });

    const response = await fetch(`/lidbrainz/search_musicbrainz/releases?${params}`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to fetch releases');
    }

    return response.json();
}



function quoteLuceneTerm(value) {
    return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}



async function handleSearch() {
    const release = releaseSearchInput.value.trim();
    let artist = artistSearchInput.value.trim();

    if(artist.toLowerCase() === "va"){
        artist = "Various Artists"
    }

    let query;
    if (artist && release) {
        query = `releasegroup:${quoteLuceneTerm(release)} AND artist:${quoteLuceneTerm(artist)}`;
    } else if (artist) {
        query = `artist:${quoteLuceneTerm(artist)}`;
    } else {
        query = release;
    }

    if (!query) return;

    try {
        let limit = parseInt(limitValueDisplay.innerText);
        const cached = searchCache[query];
        if (cached && cached.limit === limit) {
            processSearchResults(cached.results);
        }

        else {
            const results = await searchReleaseGroups(query);
            searchCache[query] = { results, limit };
            processSearchResults(results);
        }
    }

    catch (error) {
        console.error(`Search error: ${error.message}`);
    }
}



confirmSearchButton.addEventListener('click', handleSearch);

releaseSearchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSearch();
});
artistSearchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSearch();
});



function processSearchResults(results) {
    const container = document.getElementById('search-results-scrollable');
    container.innerHTML = '';
    mountedReleaseGrids.clear();
    const releaseGroups = results['release-groups'] || [];
    const bestMatchReleases = results['best-match-releases'] || [];

    releaseGroups.forEach((rg, index) => {
        const releases = index === 0 ? bestMatchReleases : null;

        container.appendChild(createReleaseGroupElement(rg, releases));
    });

    checkScrollability();
    loadAllCoverImages(container);
}

async function handleAddReleaseGroup(releaseGroupId, artistId) {
    const settings = getSettings();
    const params = new URLSearchParams({
        release_group_mbid: releaseGroupId,
        artist_mbid: artistId,
        metadata_profile_id: settings.metadataProfileId,
        quality_profile_id: settings.qualityProfileId,
        root_folder_path: settings.folderPath,
        auto_download: settings.autoDownload
    });
    const response = await fetch(`/lidbrainz/add_to_lidarr/fully_add_release?${params}`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'failed to add release group');
    }

    const result = await response.json();
    return result;
}



async function handleAddRelease(releaseGroupId, artistId, releaseId) {
    const settings = getSettings();
    const params = new URLSearchParams({
        release_group_mbid: releaseGroupId,
        artist_mbid: artistId,
        release_mbid: releaseId,
        metadata_profile_id: settings.metadataProfileId,
        quality_profile_id: settings.qualityProfileId,
        root_folder_path: settings.folderPath,
        auto_download: settings.autoDownload
    });
    const response = await fetch(`/lidbrainz/add_to_lidarr/fully_add_release?${params}`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'failed to add release');
    }

    const result = await response.json();
    return result;
}



function getArtistNames(artistCredit) {
    if (!artistCredit || !artistCredit.length) return 'N/A';
    return artistCredit.map(ac => ac.name || 'N/A').join(', ');
}



function getArtistId(artistCredit){
    if (!artistCredit || !artistCredit.length) return 'N/A';
    return artistCredit[0].artist.id || 'N/A';
}



function getYear(dateStr) {
    if (!dateStr) return 'N/A';
    return dateStr.substring(0, 4);
}



function getCountryCode(release) {
    try {
        const code = release['release-events']?.[0]?.area?.['iso-3166-1-codes']?.[0];
        if (!code) return null;
        if (code === 'XW') return 'un';
        if (code === 'XE') return 'eu';
        return code.toLowerCase();
    }

    catch { return null; }
}



function getTrackString(media) {
    if (!media || !media.length) return 'N/A';
    return media.map(m => m['track-count'] || 0).join('x');
}



function getLabelInfo(release) {
    const labelInfo = release['label-info'] || [];
    const labels = labelInfo.map(li => li.label?.name).filter(Boolean);
    const catalogNumbers = labelInfo.map(li => li['catalog-number']).filter(Boolean);

    return {
        label: labels.length ? labels.join(', ') : 'N/A',
        catalogNumber: catalogNumbers.length ? catalogNumbers.join(', ') : 'N/A',
    };
}



function getLanguageScript(release) {
    const textRepresentation = release['text-representation'];
    if (!textRepresentation) return 'N/A';

    const parts = [textRepresentation.language, textRepresentation.script].filter(Boolean);
    return parts.length ? parts.join(' / ') : 'N/A';
}



const EDITION_KEYWORDS = [
    { regex: /super deluxe/, label: 'SUPER DELUXE' },
    { regex: /deluxe/, label: 'DELUXE' },
    { regex: /box set|boxset/, label: 'BOX SET' },
    { regex: /anniversary/, label: 'ANNIVERSARY' },
    { regex: /expanded/, label: 'EXPANDED' },
    { regex: /limited edition/, label: 'LIMITED' },
    { regex: /special edition/, label: 'SPECIAL EDITION' },
];

function isRemaster(release) {
    const haystack = `${release.disambiguation || ''} ${release.title || ''}`.toLowerCase();
    return haystack.includes('remaster');
}

function getEditionTags(release) {
    const haystack = `${release.disambiguation || ''} ${release.title || ''}`.toLowerCase();
    const tags = [];

    if (isRemaster(release)) tags.push('REMASTER');

    for (const { regex, label } of EDITION_KEYWORDS) {
        if (regex.test(haystack)) {
            tags.push(label);
            if (label === 'SUPER DELUXE') break; // skip the plain DELUXE match on the same text
        }
    }

    if (release.packaging === 'Box' && !tags.includes('BOX SET')) {
        tags.push('BOX SET');
    }

    return tags;
}

function getSortableDate(release) {
    const dateStr = release['release-events']?.[0]?.date || release.date;
    if (!dateStr) return -1;

    const [y, m, d] = dateStr.split('-');
    const year = (y || '0000').padStart(4, '0');
    const month = (m || '01').padStart(2, '0');
    const day = (d || '01').padStart(2, '0');

    return parseInt(`${year}${month}${day}`, 10);
}

function sortReleasesByDateDesc(releases) {
    return [...releases].sort((a, b) => getSortableDate(b) - getSortableDate(a));
}

function formatReleaseDate(dateStr) {
    if (!dateStr || dateStr === 'N/A') return 'N/A';

    const parts = dateStr.split('-');

    if (parts.length === 3) {
        const [y, m, d] = parts;
        return `${m}-${d}-${y}`;
    }

    if (parts.length === 2) {
        const [y, m] = parts;
        return `${m}-${y}`;
    }

    return parts[0];
}



const EDITION_TAG_COLORS = {
    'REMASTER': 'yellow',
    'SUPER DELUXE': 'red',
    'DELUXE': 'main',
    'BOX SET': 'green',
    'ANNIVERSARY': 'white',
    'EXPANDED': 'white-secondary',
    'LIMITED': 'main-secondary',
    'SPECIAL EDITION': 'white-tertiary',
};

const MIN_COLUMN_WIDTH = 50;

const RELEASE_COLUMNS = [
    { id: 'title', label: 'Title', width: 220 },
    { id: 'edition', label: 'Edition', width: 160 },
    { id: 'format', label: 'Format', width: 110 },
    { id: 'tracks', label: 'Tracks', width: 80 },
    { id: 'status', label: 'Status', width: 90 },
    { id: 'country', label: 'Country', width: 90 },
    { id: 'date', label: 'Date', width: 100 },
    { id: 'label', label: 'Label', width: 140 },
    { id: 'catalogNumber', label: 'Catalog#', width: 120 },
    { id: 'barcode', label: 'Barcode', width: 120 },
    { id: 'quality', label: 'Quality', width: 90 },
    { id: 'language', label: 'Lang/Script', width: 110 },
    { id: 'disambiguation', label: 'Disambiguation', width: 170 },
];

const COLUMN_STATE_STORAGE_KEY = 'jimbrainz-release-columns';

function defaultColumnState() {
    return {
        order: RELEASE_COLUMNS.map(c => c.id),
        visible: Object.fromEntries(RELEASE_COLUMNS.map(c => [c.id, true])),
        widths: Object.fromEntries(RELEASE_COLUMNS.map(c => [c.id, c.width])),
    };
}

function loadColumnState() {
    const fallback = defaultColumnState();

    try {
        const saved = JSON.parse(localStorage.getItem(COLUMN_STATE_STORAGE_KEY));
        if (!saved || !Array.isArray(saved.order) || typeof saved.visible !== 'object') return fallback;

        // reconcile against known columns, in case the column set changed between versions
        const knownIds = new Set(RELEASE_COLUMNS.map(c => c.id));
        const order = saved.order.filter(id => knownIds.has(id));
        for (const id of knownIds) {
            if (!order.includes(id)) order.push(id);
        }

        const visible = {};
        const widths = {};
        const savedWidths = (saved.widths && typeof saved.widths === 'object') ? saved.widths : {};

        for (const id of knownIds) {
            visible[id] = saved.visible[id] !== undefined ? !!saved.visible[id] : true;
            const def = RELEASE_COLUMNS.find(c => c.id === id);
            const savedWidth = savedWidths[id];
            widths[id] = (typeof savedWidth === 'number' && savedWidth >= MIN_COLUMN_WIDTH) ? savedWidth : def.width;
        }

        return { order, visible, widths };
    }

    catch {
        return fallback;
    }
}

function saveColumnState() {
    try {
        localStorage.setItem(COLUMN_STATE_STORAGE_KEY, JSON.stringify(columnState));
    }

    catch {
        // storage unavailable (private browsing, quota, etc) - just skip persisting
    }
}

let columnState = loadColumnState();
const mountedReleaseGrids = new Set();

function notifyColumnStateChange() {
    saveColumnState();
    renderGlobalColumnsDropdown();
    mountedReleaseGrids.forEach(grid => grid.rerender());
}



/* ===== global filters (text, per-column, tags) - apply to every mounted release table ===== */

const globalFilterState = {
    text: '',
    columns: Object.fromEntries(RELEASE_COLUMNS.map(c => [c.id, ''])),
    tags: new Set(),
};

function notifyFilterStateChange() {
    mountedReleaseGrids.forEach(grid => grid.rerender());
}

const globalFilterInput = document.getElementById('global-filter-input');
globalFilterInput.addEventListener('input', () => {
    globalFilterState.text = globalFilterInput.value.trim().toLowerCase();
    notifyFilterStateChange();
});

const filtersToggleButton = document.getElementById('filters-toggle-button');
const filtersControl = document.getElementById('global-filters-control');
filtersToggleButton.addEventListener('click', (e) => {
    e.stopPropagation();
    filtersControl.classList.toggle('open');
    columnsControlGlobal.classList.remove('open');
});

const columnsToggleButtonGlobal = document.getElementById('columns-toggle-button');
const columnsControlGlobal = document.getElementById('global-columns-control');
columnsToggleButtonGlobal.addEventListener('click', (e) => {
    e.stopPropagation();
    columnsControlGlobal.classList.toggle('open');
    filtersControl.classList.remove('open');
});

document.addEventListener('click', (e) => {
    if (!filtersControl.contains(e.target)) filtersControl.classList.remove('open');
    if (!columnsControlGlobal.contains(e.target)) columnsControlGlobal.classList.remove('open');
});

function renderGlobalFiltersDropdown() {
    const dropdown = document.getElementById('filters-dropdown');
    dropdown.innerHTML = '';

    for (const col of RELEASE_COLUMNS) {
        const row = document.createElement('label');
        row.className = 'columns-dropdown-item filters-dropdown-item';

        const span = document.createElement('span');
        span.textContent = col.label;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'filters-dropdown-input';
        input.placeholder = 'contains…';
        input.addEventListener('input', () => {
            globalFilterState.columns[col.id] = input.value.trim().toLowerCase();
            notifyFilterStateChange();
        });
        input.addEventListener('click', (e) => e.stopPropagation());

        row.appendChild(span);
        row.appendChild(input);
        dropdown.appendChild(row);
    }
}
renderGlobalFiltersDropdown();

function renderGlobalColumnsDropdown() {
    const dropdown = document.getElementById('columns-dropdown');
    dropdown.innerHTML = '';

    for (const id of columnState.order) {
        const def = RELEASE_COLUMNS.find(c => c.id === id);
        const label = document.createElement('label');
        label.className = 'columns-dropdown-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!columnState.visible[id];
        checkbox.addEventListener('change', () => {
            columnState.visible[id] = checkbox.checked;
            notifyColumnStateChange();
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(def.label));
        dropdown.appendChild(label);
    }
}
renderGlobalColumnsDropdown();

const TAG_FILTER_OPTIONS = ['REMASTER', ...EDITION_KEYWORDS.map(k => k.label)];

function renderTagFilterRow() {
    const container = document.getElementById('tag-filter-row');
    container.innerHTML = '';

    for (const tag of TAG_FILTER_OPTIONS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `tag-chip ${EDITION_TAG_COLORS[tag] || 'default'}`;
        chip.textContent = tag;
        chip.addEventListener('click', () => {
            if (globalFilterState.tags.has(tag)) {
                globalFilterState.tags.delete(tag);
                chip.classList.remove('active');
            } else {
                globalFilterState.tags.add(tag);
                chip.classList.add('active');
            }
            notifyFilterStateChange();
        });
        container.appendChild(chip);
    }
}
renderTagFilterRow();



function buildReleasesGrid(releases, releaseGroupId, artistId) {
    const wrapper = document.createElement('div');
    wrapper.className = 'releases-grid-wrapper';

    const tableScroll = document.createElement('div');
    tableScroll.className = 'releases-table-scroll';

    const table = document.createElement('table');
    table.className = 'releases-table';
    const colgroup = document.createElement('colgroup');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.appendChild(colgroup);
    table.appendChild(thead);
    table.appendChild(tbody);
    tableScroll.appendChild(table);

    wrapper.appendChild(tableScroll);

    let colElements = {};

    function renderColgroup(visibleOrder) {
        colgroup.innerHTML = '';
        colElements = {};

        const expandCol = document.createElement('col');
        expandCol.style.width = '32px';
        colgroup.appendChild(expandCol);

        for (const id of visibleOrder) {
            const col = document.createElement('col');
            col.style.width = `${columnState.widths[id]}px`;
            colgroup.appendChild(col);
            colElements[id] = col;
        }

        const actionCol = document.createElement('col');
        actionCol.style.width = '110px';
        colgroup.appendChild(actionCol);
    }

    function startColumnResize(id, e) {
        e.preventDefault();
        e.stopPropagation();
        const col = colElements[id];
        const startX = e.pageX;
        const startWidth = col.getBoundingClientRect().width;

        function onMouseMove(moveEvent) {
            const delta = moveEvent.pageX - startX;
            const newWidth = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + delta));
            col.style.width = `${newWidth}px`;
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            columnState.widths[id] = parseInt(col.style.width, 10);
            notifyColumnStateChange();
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    function renderHeader() {
        const visibleOrder = columnState.order.filter(id => columnState.visible[id]);
        renderColgroup(visibleOrder);
        thead.innerHTML = '';
        const headRow = document.createElement('tr');

        const expandTh = document.createElement('th');
        expandTh.className = 'releases-col-expand';
        headRow.appendChild(expandTh);

        for (const id of visibleOrder) {
            const def = RELEASE_COLUMNS.find(c => c.id === id);
            const th = document.createElement('th');
            th.textContent = def.label;
            th.draggable = true;
            th.dataset.columnId = id;
            th.className = 'releases-col-draggable';
            th.title = 'Drag to reorder';

            th.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', id);
                th.classList.add('dragging');
            });

            th.addEventListener('dragend', () => th.classList.remove('dragging'));
            th.addEventListener('dragover', (e) => e.preventDefault());

            th.addEventListener('drop', (e) => {
                e.preventDefault();
                const draggedId = e.dataTransfer.getData('text/plain');
                if (!draggedId || draggedId === id) return;

                const order = columnState.order.filter(cid => cid !== draggedId);
                const targetIndex = order.indexOf(id);
                order.splice(targetIndex, 0, draggedId);
                columnState.order = order;
                notifyColumnStateChange();
            });

            const resizeHandle = document.createElement('div');
            resizeHandle.className = 'col-resize-handle';
            resizeHandle.draggable = false;
            resizeHandle.addEventListener('click', (e) => e.stopPropagation());
            resizeHandle.addEventListener('dragstart', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            resizeHandle.addEventListener('mousedown', (e) => startColumnResize(id, e));
            th.appendChild(resizeHandle);

            headRow.appendChild(th);
        }

        const actionTh = document.createElement('th');
        actionTh.className = 'releases-col-action';
        headRow.appendChild(actionTh);

        thead.appendChild(headRow);
    }

    function renderBody() {
        tbody.innerHTML = '';
        const visibleOrder = columnState.order.filter(id => columnState.visible[id]);
        const colspan = visibleOrder.length + 2; // + expand column + action column

        for (const release of releases) {
            const title = release.title || 'N/A';
            const format = release.media?.[0]?.format || 'N/A';
            const tracks = getTrackString(release.media);
            const status = release.status || 'N/A';
            const countryCode = getCountryCode(release);
            const countryDisplay = release['release-events']?.[0]?.area?.['iso-3166-1-codes']?.[0] || 'N/A';
            const rawDate = release['release-events']?.[0]?.date || release.date || 'N/A';
            const date = formatReleaseDate(rawDate);
            const releaseId = release.id;
            const media = release.media || [];
            const editionTags = getEditionTags(release);
            const disambiguation = release.disambiguation || 'N/A';
            const { label, catalogNumber } = getLabelInfo(release);
            const barcode = release.barcode || 'N/A';
            const quality = release.quality || 'N/A';
            const language = getLanguageScript(release);

            const fieldValues = {
                title, edition: editionTags.join(' '), format, tracks, status,
                country: countryDisplay, date, label, catalogNumber, barcode,
                quality, language, disambiguation,
            };

            const searchText = Object.values(fieldValues).join(' ').toLowerCase();
            if (globalFilterState.text && !searchText.includes(globalFilterState.text)) continue;

            let columnFilterMismatch = false;
            for (const [colId, filterValue] of Object.entries(globalFilterState.columns)) {
                if (!filterValue) continue;
                const fieldText = String(fieldValues[colId] ?? '').toLowerCase();
                if (!fieldText.includes(filterValue)) {
                    columnFilterMismatch = true;
                    break;
                }
            }
            if (columnFilterMismatch) continue;

            if (globalFilterState.tags.size > 0 && !editionTags.some(t => globalFilterState.tags.has(t))) continue;

            let totalTracks = 0;
            for (const disc of media) totalTracks += (disc.tracks?.length || 0);

            const row = document.createElement('tr');
            row.className = 'release-row';

            const expandCell = document.createElement('td');
            expandCell.className = 'releases-col-expand';
            expandCell.textContent = totalTracks > 0 ? '▷' : '';
            row.appendChild(expandCell);

            for (const id of visibleOrder) {
                const td = document.createElement('td');
                td.className = `releases-col-${id}`;

                if (id === 'title') {
                    td.innerHTML = `<h4 class="text white releaseGridTitle"><a href="https://musicbrainz.org/release/${releaseId}" target="_blank" rel="noopener noreferrer">${title}</a></h4>`;
                }

                else if (id === 'edition') {
                    td.innerHTML = editionTags.length
                        ? editionTags.map(tag => `<h4 class="text ${EDITION_TAG_COLORS[tag] || 'default'} edition-tag" title="${disambiguation}">${tag}</h4>`).join('')
                        : `<h4 class="text default-muted">—</h4>`;
                }

                else if (id === 'format') {
                    td.innerHTML = `<h4 class="text default">${format}</h4>`;
                }

                else if (id === 'tracks') {
                    td.innerHTML = `<h4 class="text default">${tracks}</h4>`;
                }

                else if (id === 'status') {
                    td.innerHTML = `<h4 class="text default-secondary">${status}</h4>`;
                }

                else if (id === 'country') {
                    td.innerHTML = `
                        ${countryCode ? `<img src="https://flagcdn.com/${countryCode}.svg">` : `<img src="https://upload.wikimedia.org/wikipedia/commons/b/b0/No_flag.svg">`}
                        <h4 class="text white">${countryDisplay}</h4>
                    `;
                }

                else if (id === 'date') {
                    td.innerHTML = `<h4 class="text white">${date}</h4>`;
                }

                else if (id === 'label') {
                    td.innerHTML = `<h4 class="text default">${label}</h4>`;
                }

                else if (id === 'catalogNumber') {
                    td.innerHTML = `<h4 class="text default-secondary">${catalogNumber}</h4>`;
                }

                else if (id === 'barcode') {
                    td.innerHTML = `<h4 class="text default-secondary">${barcode}</h4>`;
                }

                else if (id === 'quality') {
                    td.innerHTML = `<h4 class="text default-secondary">${quality}</h4>`;
                }

                else if (id === 'language') {
                    td.innerHTML = `<h4 class="text default-secondary">${language}</h4>`;
                }

                else if (id === 'disambiguation') {
                    td.innerHTML = `<h4 class="text default-muted">${disambiguation}</h4>`;
                }

                row.appendChild(td);
            }

            const actionCell = document.createElement('td');
            actionCell.className = 'releases-col-action';
            actionCell.innerHTML = `<h4 class="text green releaseAddButton">Add release</h4>`;
            actionCell.querySelector('.releaseAddButton').addEventListener('click', async (e) => {
                e.stopPropagation();

                try {
                    await handleAddRelease(releaseGroupId, artistId, releaseId);
                }

                catch (error) {
                    console.error(`Add release error: ${error.message}`);
                }
            });
            row.appendChild(actionCell);

            tbody.appendChild(row);

            if (totalTracks > 0) {
                row.classList.add('has-tracks');

                const tracksRow = document.createElement('tr');
                tracksRow.className = 'release-tracks-row';

                const tracksCell = document.createElement('td');
                tracksCell.colSpan = colspan;

                const tracksContainer = document.createElement('div');
                tracksContainer.className = 'release-tracks';

                for (const disc of media) {
                    for (const track of (disc.tracks || [])) {
                        const { minutes, seconds } = millisecondsToMinutesAndSeconds(track.recording?.length);
                        const recordingTitle = track.recording?.title || 'N/A';
                        const recordingId = track.recording?.id;
                        const lengthStr = minutes === 'N/A' ? 'N/A' : `${minutes}:${seconds.toString().padStart(2, '0')}`;
                        const trackDiv = document.createElement('div');
                        trackDiv.className = 'track';
                        trackDiv.innerHTML = `
                            <h4 class="text default trackNumber">${track.number}.${track.position}</h4>
                            <h4 class="text white trackName"><a href="https://musicbrainz.org/recording/${recordingId}" target="_blank" rel="noopener noreferrer">${recordingTitle}</a></h4>
                            <h4 class="text white-tertiary trackLength">[${lengthStr}]</h4>
                        `;
                        tracksContainer.appendChild(trackDiv);
                    }
                }

                tracksCell.appendChild(tracksContainer);
                tracksRow.appendChild(tracksCell);
                tbody.appendChild(tracksRow);

                row.addEventListener('click', (e) => {
                    if (e.target.closest('a') || e.target.closest('.releaseAddButton')) return;
                    tracksContainer.classList.toggle('expanded');
                    expandCell.textContent = tracksContainer.classList.contains('expanded') ? '▽' : '▷';
                    checkScrollability();
                });
            }
        }

        if (!tbody.children.length) {
            const emptyRow = document.createElement('tr');
            const emptyCell = document.createElement('td');
            emptyCell.colSpan = colspan;
            emptyCell.className = 'releases-empty-cell';
            emptyCell.innerHTML = `<h4 class="text default-muted">No releases match your filters</h4>`;
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
        }
    }

    function rerender() {
        renderHeader();
        renderBody();
    }

    rerender();
    mountedReleaseGrids.add({ rerender });

    return wrapper;
}

function millisecondsToMinutesAndSeconds(ms) {

    if (ms === undefined || ms === null) return { minutes: 'N/A', seconds: '' };

    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return {
        minutes: minutes,
        seconds: seconds
    }
}

function createReleaseGroupElement(releaseGroup, releases = null) {
    if (releases && releases.length) {
        releases = sortReleasesByDateDesc(releases);
    }

    const artist = getArtistNames(releaseGroup['artist-credit']);
    const title = releaseGroup.title || 'N/A';
    const year = getYear(releaseGroup['first-release-date']);
    const type = releaseGroup['primary-type'] || 'N/A';
    const secondaryTypes = releaseGroup['secondary-types'] || [];
    const typeDisplay = secondaryTypes.length ? `${type}, ${secondaryTypes.join(', ')}` : type;
    const score = releaseGroup.score ?? 'N/A';
    const releaseGroupId = releaseGroup.id;
    const artistId = getArtistId(releaseGroup['artist-credit']);
    const imageWrapper = document.createElement('div');
    imageWrapper.className = 'results-box-image-container';
    imageWrapper.setAttribute('data-mbid', releaseGroupId);
    const div = document.createElement('div');
    div.className = 'results-box release-group-result';

    let html =
    `
        <div class="release-group-header">
            <div class="shrinkable">
                <h3 class="text white-tertiary releaseGrpArtist">
                    <a href="https://musicbrainz.org/artist/${artistId}" target="_blank" rel="noopener noreferrer">${artist}</a>&nbsp;-&nbsp;
                </h3>
                <h3 class="text white releaseGrpName">
                    <a href="https://musicbrainz.org/release-group/${releaseGroupId}" target="_blank" rel="noopener noreferrer">${title} (${year})</a>
                </h3>
                <h3 class="text white-tertiary releaseGrpType">&nbsp;[${typeDisplay}] &nbsp;</h3>
            </div>
            <div class="non-shrinkable">
                <h3 class="text default matchScore">Match%: ${score}</h3>
                <button class="text default addButton" type="button">Add</button>
            </div>
        </div>
    `;

    if (releases && releases.length) {
        html +=
        `
            <hr>
            <button class="releases-toggle-button" type="button">
                <hr>
                <h4 class="text white releaseName">Specific releases ▷ (${releases.length})</h4>
            </button>
            <div class="release-group-releases"></div>
        `;
    }

    else if (releases === null) {
        html +=
        `
            <hr>
            <button class="releases-toggle-button fetch-releases-button" type="button">
                <hr>
                <h4 class="text white releaseName">Fetch releases</h4>
            </button>
        `;
    }

    div.innerHTML = html;

    div.querySelector('.addButton').addEventListener('click', async () => {
        let status;

        try {
            status = await handleAddReleaseGroup(releaseGroupId, artistId)
        }

        catch (error) {
            status = `Add release group error: ${error.message}`;
        }
    });

    if (releases && releases.length) {
        const releasesContainer = div.querySelector('.release-group-releases');
        const toggleButton = div.querySelector('.releases-toggle-button');
        releasesContainer.appendChild(buildReleasesGrid(releases, releaseGroupId, artistId));

        toggleButton.addEventListener('click', () => {
            releasesContainer.classList.toggle('expanded');

            if (releasesContainer.classList.contains('expanded')) {
                toggleButton.innerHTML = `<h4 class="text white releaseName">Specific releases ▽ (${releases.length})</h4>`;
            }
            else {
                toggleButton.innerHTML = `<h4 class="text white releaseName">Specific releases ▷ (${releases.length})</h4>`;
            }

            checkScrollability();
        });
    }


    else if (releases === null) {
        const fetchButton = div.querySelector('.fetch-releases-button');

        fetchButton.addEventListener('click', async () => {
            try {
                const result = await fetchReleases(releaseGroupId);

                const fetchedReleases = sortReleasesByDateDesc(result.releases);

                const newHtml =
                `
                    <hr>
                    <button class="releases-toggle-button" type="button">
                        <hr>
                        <h4 class="text white releaseName">Specific releases ▷ (${fetchedReleases.length})</h4>
                    </button>
                    <div class="release-group-releases"></div>
                `;

                fetchButton.parentElement.querySelector('hr').remove();
                fetchButton.remove();
                div.insertAdjacentHTML('beforeend', newHtml);
                const releasesContainer = div.querySelector('.release-group-releases');
                const toggleButton = div.querySelector('.releases-toggle-button');
                releasesContainer.appendChild(buildReleasesGrid(fetchedReleases, releaseGroupId, artistId));

                toggleButton.addEventListener('click', () => {
                    releasesContainer.classList.toggle('expanded');

                    if (releasesContainer.classList.contains('expanded')) {
                        toggleButton.innerHTML = `<h4 class="text white releaseName">Specific releases ▽ (${fetchedReleases.length})</h4>`;
                    }
                    else {
                        toggleButton.innerHTML = `<h4 class="text white releaseName">Specific releases ▷ (${fetchedReleases.length})</h4>`;
                    }

                    checkScrollability();
                });
            }

            catch (error) {
                console.error(`Fetch releases error: ${error.message}`);
            }
        });
    }

    if (score < 90) {
        imageWrapper.style.opacity = '0.55';
    }

    imageWrapper.appendChild(div);
    return imageWrapper;
}
