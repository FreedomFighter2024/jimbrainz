import { init} from './init.js';
import {sleep} from './utils.js';



document.addEventListener('DOMContentLoaded', async () => {
    init({refreshServerConfig})
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



async function fetchServerConfig() {
    console.log("getting server config")
    const response = await fetch(`/jimbrainz/monitor_slskd/config`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to fetch server config');
    }

    return response.json();
}



async function refreshServerConfig() {
    console.log("refreshing server config")
    try {
        const serverConfig = await fetchServerConfig();
        populateFormatPreference();
        setLabel('library-path-display', serverConfig.library_path || 'not configured');
        return serverConfig;
    }

    catch (error) {
        // still render the format picker, it's purely client side
        populateFormatPreference();
    }
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

function setLabel(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = text || '—';
}

/* the download profile lives in a top-bar popover now that the right sidebar is gone */
const profileControl = document.getElementById('profile-control');
document.getElementById('profile-toggle-button').addEventListener('click', (e) => {
    e.stopPropagation();
    profileControl.classList.toggle('open');
    if (typeof setLogOpen === 'function') setLogOpen(false);
});
document.addEventListener('click', (e) => {
    if (!profileControl.contains(e.target)) profileControl.classList.remove('open');
});

const autoGrabCheckbox = document.getElementById('auto-download-checkbox');
if (typeof downloadDefaults.autoGrab === 'boolean') {
    autoGrabCheckbox.checked = downloadDefaults.autoGrab;
}
autoGrabCheckbox.addEventListener('change', () => {
    saveDownloadDefaults({ autoGrab: autoGrabCheckbox.checked });
});



const FORMAT_PREFERENCES = [
    { id: 'any', name: 'Any format' },
    { id: 'prefer_lossless', name: 'Prefer lossless' },
    { id: 'lossless_only', name: 'Lossless only' },
];

function populateFormatPreference() {
    console.log("populating format preference")
    const container = document.getElementById('format-preference-select');
    container.innerHTML = '';

    const savedId = downloadDefaults.formatPreference;
    const savedExists = FORMAT_PREFERENCES.some(f => f.id === savedId);
    const selectedId = savedExists ? savedId : 'prefer_lossless';

    FORMAT_PREFERENCES.forEach(format => {
        const elementId = `format-preference-${format.id}`;
        container.innerHTML +=
        `
            <input type="radio" id="${elementId}" name="format-preference" value="${format.id}" ${format.id === selectedId ? 'checked' : ''}>
            <label for="${elementId}">\u2514\u2500\u2572 ${format.name}</label>
        `;
    });

    container.addEventListener('change', () => {
        const checked = document.querySelector('#format-preference-select > input[type="radio"]:checked');
        if (!checked) return;
        saveDownloadDefaults({ formatPreference: checked.value });
    });
}



function getSettings() {
    const checkedFormat = document.querySelector('#format-preference-select > input[type="radio"]:checked');
    return {
        formatPreference: checkedFormat ? checkedFormat.value : 'prefer_lossless',
        autoGrab: document.getElementById('auto-download-checkbox').checked,
    };
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



/* ===== downloads dropdown (ported to Preact - see ui/src/components/DownloadsPanel.tsx) ===== */

/*
 * The downloads panel is rendered by the Preact bundle now, into #downloads-root. What used
 * to be ~260 lines here - polling, byte-delta speed sampling, and a hand-written keyed
 * reconciler that looked rows up by data-job-id and shuffled them with insertBefore - is
 * gone. Only the two calls that genuinely cross the boundary are left.
 *
 * This file is a module, so its functions aren't reachable from another bundle. Both sides
 * meet on window.jimbrainz instead. See ui/src/bridge.ts; keep it shrinking.
 */
window.jimbrainz = window.jimbrainz || {};

// called by the panel when it opens - only one dropdown should be open at a time
window.jimbrainz.closeOtherDropdowns = () => {
    profileControl.classList.remove('open');
    setLogOpen(false);
};

/*
 * Run a MusicBrainz search on the vanilla side, for the library view's clickable artist and
 * album names.
 *
 * Fills the real inputs rather than calling handleSearch with arguments, so the search box
 * ends up showing the query that produced the results - landing on a populated results list
 * with empty inputs reads like a bug, and it means the user can edit and re-run it.
 */
/*
 * Collapse the filter column on narrow screens.
 *
 * The toggle only exists on mobile (CSS hides it otherwise), and starts collapsed there:
 * filters are secondary to results on a phone, and a 190px column above the list pushed the
 * first album most of the way off the screen. Nothing here runs on desktop beyond wiring the
 * listener, and the class is inert without the media query.
 */
(() => {
    const column = document.getElementById('filter-column');
    const toggle = document.querySelector('#filter-column-header .filter-collapse-toggle');
    if (!column || !toggle) return;

    column.classList.add('collapsed');

    toggle.addEventListener('click', () => {
        const collapsed = column.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.textContent = collapsed ? '▾' : '▴';
    });
})();

window.jimbrainz.runSearch = ({ artist = '', album = '' } = {}) => {
    artistSearchInput.value = artist;
    releaseSearchInput.value = album;
    handleSearch();
};




/* ===== log dropdown (anchored under its own button in the top bar) ===== */

const LOG_STATE_STORAGE_KEY = 'jimbrainz-log-open';
const logControl = document.getElementById('log-control');
const logToggleButton = document.getElementById('log-toggle-button');
const logUnreadBadge = document.getElementById('log-unread-badge');
let unreadLogCount = 0;

function isLogOpen() {
    return logControl.classList.contains('open');
}

function setLogOpen(open) {
    logControl.classList.toggle('open', open);

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

logToggleButton.addEventListener('click', (e) => {
    e.stopPropagation();
    setLogOpen(!isLogOpen());
    profileControl.classList.remove('open');
});

document.addEventListener('click', (e) => {
    if (isLogOpen() && !logControl.contains(e.target)) setLogOpen(false);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isLogOpen()) setLogOpen(false);
});

const logObserver = new MutationObserver((mutations) => {
    if (isLogOpen()) return;

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



/*
 * Show that a search is running. The results area is the honest place for it - it is where
 * the answer will appear, and it is otherwise empty for however long MusicBrainz takes.
 */
function setSearchLoading(on) {
    const results = document.getElementById('search-results-scrollable');
    const button = document.getElementById('search-input-button');

    if (button) {
        button.disabled = on;
        button.textContent = on ? 'Searching' : 'Search';
    }

    if (!results) return;

    if (on) {
        results.innerHTML = '<div class="loading-panel">asking MusicBrainz...</div>';
    }

    else {
        const placeholder = results.querySelector('.loading-panel');
        if (placeholder) placeholder.remove();
    }
}


async function searchReleaseGroups(query) {
    const params = new URLSearchParams({
        query: query,
        limit: parseInt(limitValueDisplay.innerText)
    });

    const response = await fetch(`/jimbrainz/search_musicbrainz/fully_search?${params}`);

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

    const response = await fetch(`/jimbrainz/search_musicbrainz/releases?${params}`);

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
            // MusicBrainz is regularly slow and was sometimes unreachable, and until now the
            // page showed nothing at all while waiting - which reads as the button not having
            // worked. A cache hit skips this because it returns in the same tick.
            setSearchLoading(true);
            try {
                const results = await searchReleaseGroups(query);
                searchCache[query] = { results, limit };
                processSearchResults(results);
            } finally {
                setSearchLoading(false);
            }
        }
    }

    catch (error) {
        console.error(`Search error: ${error.message}`);
        // surface it in the results area - a silent console error looks like "no matches",
        // which sends people rewording a search that never actually ran
        document.getElementById('search-results-scrollable').innerHTML =
            `<h4 class="text red candidates-status">${error.message}</h4>`;
        updateResultsSummary();
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
    renderFacets();
    updateResultsSummary();
}

async function findCandidates(expected) {
    const settings = getSettings();
    const response = await fetch(`/jimbrainz/download/find_candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...expected, format_preference: settings.formatPreference })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'search failed');
    }

    return response.json();
}



async function enqueueCandidate(candidate) {
    // the release travels with the download so the server can remember what these files are
    // for - slskd only ever knows "bob is sending you some files"
    const response = await fetch(`/jimbrainz/download/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: candidate.username,
            files: candidate.files,
            directory: candidate.directory,
            release: currentExpected || {},
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'failed to queue download');
    }

    const result = await response.json();
    // show the new job straight away rather than on the panel's next timer tick. Optional
    // because the two bundles load independently - if it isn't there yet, the poll covers it.
    window.jimbrainz?.refreshDownloads?.();
    return result;
}



/* ===== soulseek candidate picker ===== */

const candidatesWindow = document.getElementById('candidates-window');
const candidatesScrollable = document.getElementById('candidates-scrollable');
const candidatesQueryInput = document.getElementById('candidates-query-input');
let currentExpected = null;

function setCandidatesOpen(open) {
    candidatesWindow.classList.toggle('open', open);
}

document.getElementById('candidates-close-button').addEventListener('click', () => setCandidatesOpen(false));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && candidatesWindow.classList.contains('open')) setCandidatesOpen(false);
});

document.getElementById('candidates-requery-button').addEventListener('click', () => {
    if (!currentExpected) return;
    runCandidateSearch({ ...currentExpected, query_override: candidatesQueryInput.value.trim() });
});



function buildExpectedFromRelease(release, releaseGroupContext) {
    // MusicBrainz numbers tracks per-disc, so a 2xCD set has two "track 1"s. The matcher keys
    // its file mapping on position, so flatten to a running number across all discs.
    const tracks = [];
    let position = 0;

    for (const disc of (release.media || [])) {
        for (const track of (disc.tracks || [])) {
            position += 1;
            tracks.push({
                position,
                title: track.recording?.title || track.title || '',
                length_ms: track.recording?.length ?? track.length ?? null,
            });
        }
    }

    const rawDate = release['release-events']?.[0]?.date || release.date || '';
    const labelInfo = (release['label-info'] || [])
        .map(entry => entry['catalog-number'])
        .filter(Boolean);

    return {
        artist: releaseGroupContext.artist,
        album: release.title || releaseGroupContext.album,
        year: rawDate ? rawDate.substring(0, 4) : releaseGroupContext.year,
        release_mbid: release.id,
        edition_tags: getEditionTags(release),
        tracks,

        // everything below is what lets the organizer file two editions of the same album
        // into separate folders instead of one silently skipping against the other. See
        // src/editions.py - `disambiguation` is by far the most useful of them, being
        // MusicBrainz's own words for how this release differs from its siblings.
        release_group_mbid: releaseGroupContext.releaseGroupId || null,
        disambiguation: release.disambiguation || null,
        media_format: (release.media || []).map(m => m.format).filter(Boolean).join(' + ') || null,
        // the raw ISO code, NOT getCountryCode() - that one rewrites the "worldwide" codes
        // XW/XE into 'un'/'eu' for flag display, and src/editions.py needs to recognise and
        // discard them rather than labelling a folder "[UN]"
        country: release['release-events']?.[0]?.area?.['iso-3166-1-codes']?.[0]
                 || release.country || null,
        catalog_number: labelInfo.join(', ') || null,
    };
}



function buildExpectedFromReleaseGroup(releaseGroupContext) {
    // No specific release picked, so there's no tracklist to match against. The matcher
    // drops the tracklist-dependent signals rather than scoring these as failures.
    return {
        artist: releaseGroupContext.artist,
        album: releaseGroupContext.album,
        year: releaseGroupContext.year,
        release_mbid: null,
        edition_tags: [],
        tracks: [],
    };
}



async function openCandidatesPanel(expected, label) {
    currentExpected = expected;
    document.getElementById('candidates-release-label').textContent = label;
    setCandidatesOpen(true);
    await runCandidateSearch(expected);
}



async function runCandidateSearch(expected) {
    candidatesScrollable.innerHTML =
        `<div class="loading-panel">searching soulseek for this release...</div>`;

    try {
        const result = await findCandidates(expected);
        candidatesQueryInput.value = result.query;
        lastCandidateResult = result;
        renderCandidateFormatFilters(result.candidates);
        renderCandidates();
    }

    catch (error) {
        console.error(`Candidate search error: ${error.message}`);
        lastCandidateResult = null;
        candidatesScrollable.innerHTML =
            `<h4 class="text red candidates-status">search failed: ${error.message}</h4>`;
    }
}



const SIGNAL_LABELS = {
    title_match: 'titles',
    track_count: 'count',
    duration_match: 'lengths',
    edition: 'edition',
    format: 'format',
    peer: 'peer',
};

let lastCandidateResult = null;
const candidateFilterState = {
    freeSlotOnly: false, completeOnly: false, minScore: 0, formats: new Set(),
    // per-signal minimums, e.g. "only show me folders where every track length lines up"
    minSignals: Object.fromEntries(Object.keys(SIGNAL_LABELS).map(k => [k, 0])),
};

/**
 * Soulseek reports transfer rates in bytes/sec (protocol "avgspeed"), which slskd passes
 * through unchanged on both search responses and transfers. Displayed as KB/s | MB/s.
 */
function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond) return 'unknown';

    const kb = bytesPerSecond / 1024;
    if (kb < 1024) return `${Math.round(kb)} KB/s`;
    return `${(kb / 1024).toFixed(1)} MB/s`;
}

function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

document.getElementById('candidate-free-slot-only').addEventListener('change', (e) => {
    candidateFilterState.freeSlotOnly = e.target.checked;
    renderCandidates();
});

document.getElementById('candidate-complete-only').addEventListener('change', (e) => {
    candidateFilterState.completeOnly = e.target.checked;
    renderCandidates();
});

const minScoreInput = document.getElementById('candidate-min-score');
minScoreInput.addEventListener('input', (e) => {
    candidateFilterState.minScore = Number(e.target.value);
    document.getElementById('candidate-min-score-value').textContent = e.target.value;
    renderCandidates();
});

/*
 * Per-signal thresholds live in a dropdown rather than inline: six always-visible sliders
 * ate most of the panel, and this is a tuning control you reach for occasionally, not
 * something to stare at. The badge keeps any active threshold from becoming hidden state.
 */
const candidateSignalsControl = document.getElementById('candidate-signals-control');
const candidateSignalsBadge = document.getElementById('candidate-signals-badge');

document.getElementById('candidate-signals-button').addEventListener('click', (e) => {
    e.stopPropagation();
    candidateSignalsControl.classList.toggle('open');
});
document.addEventListener('click', (e) => {
    if (!candidateSignalsControl.contains(e.target)) candidateSignalsControl.classList.remove('open');
});

function updateSignalsBadge() {
    const active = Object.values(candidateFilterState.minSignals).filter(Boolean).length;
    candidateSignalsBadge.hidden = active === 0;
    candidateSignalsBadge.textContent = active;
    candidateSignalsControl.classList.toggle('has-active', active > 0);
}

function renderCandidateSignalSliders() {
    const container = document.getElementById('candidate-signal-sliders');
    if (container.dataset.built) return;
    container.dataset.built = '1';

    for (const [signal, label] of Object.entries(SIGNAL_LABELS)) {
        const wrapper = document.createElement('label');
        wrapper.className = 'candidate-signal-slider';

        const name = document.createElement('span');
        name.className = 'text default-secondary';
        name.textContent = label;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0'; slider.max = '100'; slider.step = '5'; slider.value = '0';

        const readout = document.createElement('span');
        readout.className = 'text default candidate-signal-value';
        readout.textContent = '0';

        slider.addEventListener('input', () => {
            candidateFilterState.minSignals[signal] = Number(slider.value);
            readout.textContent = slider.value;
            wrapper.classList.toggle('active', Number(slider.value) > 0);
            updateSignalsBadge();
            renderCandidates();
        });
        slider.addEventListener('click', (e) => e.stopPropagation());

        wrapper.append(name, slider, readout);
        container.appendChild(wrapper);
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'signals-reset-button';
    reset.textContent = 'reset';
    reset.addEventListener('click', (e) => {
        e.stopPropagation();
        for (const input of container.querySelectorAll('input[type="range"]')) {
            input.value = '0';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
    container.appendChild(reset);
}
renderCandidateSignalSliders();


function renderCandidateFormatFilters(candidates) {
    const container = document.getElementById('candidate-format-filters');
    container.innerHTML = '';
    candidateFilterState.formats.clear();

    const formats = [...new Set(candidates.flatMap(c => c.formats))].filter(Boolean).sort();

    for (const format of formats) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tag-chip main';
        chip.textContent = format;
        chip.addEventListener('click', () => {
            if (candidateFilterState.formats.has(format)) {
                candidateFilterState.formats.delete(format);
                chip.classList.remove('active');
            } else {
                candidateFilterState.formats.add(format);
                chip.classList.add('active');
            }
            renderCandidates();
        });
        container.appendChild(chip);
    }
}

function candidatePassesFilters(candidate) {
    if (candidateFilterState.freeSlotOnly && !candidate.has_free_slot) return false;
    if (Math.round(candidate.score * 100) < candidateFilterState.minScore) return false;

    if (candidateFilterState.completeOnly && candidate.expected_tracks
        && candidate.matched_tracks < candidate.expected_tracks) return false;

    if (candidateFilterState.formats.size
        && !candidate.formats.some(f => candidateFilterState.formats.has(f))) return false;

    for (const [signal, minimum] of Object.entries(candidateFilterState.minSignals)) {
        if (!minimum) continue;
        const value = candidate.signals[signal];

        // null means the signal couldn't be judged - slskd didn't report track lengths, say.
        // If you've asked for a minimum there, "unknown" cannot satisfy it.
        if (value === null || value === undefined) return false;
        if (Math.round(value * 100) < minimum) return false;
    }

    return true;
}

function renderCandidates() {
    candidatesScrollable.innerHTML = '';

    if (!lastCandidateResult) return;

    const { candidates, response_count } = lastCandidateResult;

    if (!candidates.length) {
        candidatesScrollable.innerHTML =
            `<h4 class="text default-muted candidates-status">no matches from ${response_count} responses — try editing the query above</h4>`;
        return;
    }

    const visible = candidates.filter(candidatePassesFilters);

    if (!visible.length) {
        candidatesScrollable.innerHTML =
            `<h4 class="text default-muted candidates-status">${candidates.length} candidates, none match your filters</h4>`;
        return;
    }

    for (const candidate of visible) {
        const box = document.createElement('div');
        box.className = 'candidate-box';

        const scorePercent = Math.round(candidate.score * 100);
        const scoreClass = scorePercent >= 75 ? 'good' : scorePercent >= 40 ? 'mid' : 'bad';
        const trackSummary = candidate.expected_tracks
            ? `${candidate.matched_tracks}/${candidate.expected_tracks} tracks`
            : `${candidate.audio_file_count} files`;

        const signalMarkup = Object.entries(candidate.signals)
            .filter(([, value]) => value !== null)
            .map(([key, value]) => {
                const pct = Math.round(value * 100);
                return `<span class="candidate-signal ${pct >= 75 ? 'good' : pct >= 40 ? 'mid' : 'bad'}">${SIGNAL_LABELS[key] || key} ${pct}</span>`;
            })
            .join('');

        const editionMarkup = candidate.detected_edition_tags
            .map(tag => `<h4 class="text ${EDITION_TAG_COLORS[tag] || 'default'} edition-tag">${tag}</h4>`)
            .join('');

        const bitrateText = candidate.bitrates?.length
            ? ` ${candidate.bitrates.length > 1
                ? `${Math.min(...candidate.bitrates)}-${Math.max(...candidate.bitrates)}`
                : candidate.bitrates[0]}kbps`
            : '';

        const sizeText = formatSize(candidate.total_size);

        box.innerHTML = `
            <div class="candidate-main">
                <div class="candidate-score ${scoreClass}">${scorePercent}</div>
                <div class="candidate-body">
                    <h4 class="text white candidate-dir" title="${candidate.directory}">${candidate.directory_name}</h4>
                    <div class="candidate-meta">
                        <span class="text default-secondary">${candidate.username}</span>
                        <span class="text default-muted">·</span>
                        <span class="text default-secondary">${trackSummary}</span>
                        <span class="text default-muted">·</span>
                        <span class="text default-secondary">${candidate.formats.join(', ') || 'unknown'}${bitrateText}</span>
                        ${sizeText ? `<span class="text default-muted">·</span><span class="text default-secondary">${sizeText}</span>` : ''}
                    </div>
                    <div class="candidate-peer">
                        <span class="candidate-speed">▼ ${formatSpeed(candidate.upload_speed)}</span>
                        <span class="candidate-slot ${candidate.has_free_slot ? 'free' : 'busy'}">${candidate.has_free_slot ? 'free slot' : 'no free slot'}</span>
                        <span class="text default-muted">queue ${candidate.queue_length}</span>
                    </div>
                    <div class="candidate-tags">${editionMarkup}</div>
                    <div class="candidate-signals">${signalMarkup}</div>
                </div>
                <button type="button" class="candidate-download-button">Download</button>
            </div>
        `;

        const button = box.querySelector('.candidate-download-button');
        button.addEventListener('click', async () => {
            button.disabled = true;
            button.textContent = 'queueing…';

            try {
                await enqueueCandidate(candidate);
                button.textContent = 'queued ✓';
                box.classList.add('queued');
            }

            catch (error) {
                console.error(`Enqueue error: ${error.message}`);
                button.textContent = 'failed';
                button.disabled = false;
            }
        });

        candidatesScrollable.appendChild(box);
    }
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



/* ===== global filters: free text + checkbox facets, applied to every mounted release table ===== */

// Facet values are derived from whatever is actually on screen rather than hardcoded, so the
// checkboxes only ever offer things that exist in the current results.
const FACET_DEFS = [
    { id: 'edition', label: 'edition', valuesOf: (release) => getEditionTags(release) },
    { id: 'format', label: 'format', valuesOf: (release) => [release.media?.[0]?.format].filter(Boolean) },
    { id: 'status', label: 'status', valuesOf: (release) => [release.status].filter(Boolean) },
    { id: 'country', label: 'country', valuesOf: (release) =>
        [release['release-events']?.[0]?.area?.['iso-3166-1-codes']?.[0]].filter(Boolean) },
    { id: 'label', label: 'label', valuesOf: (release) =>
        (release['label-info'] || []).map(li => li.label?.name).filter(Boolean) },
];

// Each facet tracks two sets so a value can be required *or* ruled out - the point being
// things like "any pressing except the deluxe edition", which a plain checkbox can't say.
const globalFilterState = {
    text: '',
    facets: Object.fromEntries(FACET_DEFS.map(f => [f.id, { include: new Set(), exclude: new Set() }])),
};

const FACET_STATES = ['neutral', 'include', 'exclude'];
const FACET_MARKERS = { neutral: '[ ]', include: '[+]', exclude: '[-]' };

function facetStateOf(facetId, value) {
    const facet = globalFilterState.facets[facetId];
    if (facet.include.has(value)) return 'include';
    if (facet.exclude.has(value)) return 'exclude';
    return 'neutral';
}

function cycleFacetState(facetId, value) {
    const facet = globalFilterState.facets[facetId];
    const next = FACET_STATES[(FACET_STATES.indexOf(facetStateOf(facetId, value)) + 1) % FACET_STATES.length];

    facet.include.delete(value);
    facet.exclude.delete(value);
    if (next === 'include') facet.include.add(value);
    if (next === 'exclude') facet.exclude.add(value);

    return next;
}

function notifyFilterStateChange() {
    mountedReleaseGrids.forEach(grid => grid.rerender());
    renderFacets();
    updateResultsSummary();
}

function releaseMatchesFilters(release, searchText) {
    if (globalFilterState.text && !searchText.includes(globalFilterState.text)) return false;

    // multi-select inside one facet is OR, across facets it's AND - standard faceted search.
    // Exclusions are checked first and always win: one excluded value drops the release even
    // if it also matches something in the include set.
    for (const def of FACET_DEFS) {
        const { include, exclude } = globalFilterState.facets[def.id];
        if (!include.size && !exclude.size) continue;

        const values = def.valuesOf(release);

        if (exclude.size && values.some(v => exclude.has(v))) return false;
        if (include.size && !values.some(v => include.has(v))) return false;
    }

    return true;
}

const globalFilterInput = document.getElementById('global-filter-input');
globalFilterInput.addEventListener('input', () => {
    globalFilterState.text = globalFilterInput.value.trim().toLowerCase();
    notifyFilterStateChange();
});

document.getElementById('clear-filters-button').addEventListener('click', () => {
    globalFilterState.text = '';
    globalFilterInput.value = '';
    for (const facet of Object.values(globalFilterState.facets)) {
        facet.include.clear();
        facet.exclude.clear();
    }
    notifyFilterStateChange();
});

const columnsToggleButtonGlobal = document.getElementById('columns-toggle-button');
const columnsControlGlobal = document.getElementById('global-columns-control');
columnsToggleButtonGlobal.addEventListener('click', (e) => {
    e.stopPropagation();
    columnsControlGlobal.classList.toggle('open');
});

document.addEventListener('click', (e) => {
    if (!columnsControlGlobal.contains(e.target)) columnsControlGlobal.classList.remove('open');
});

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



function allMountedReleases() {
    const releases = [];
    mountedReleaseGrids.forEach(grid => releases.push(...grid.releases));
    return releases;
}

function computeFacetCounts() {
    const counts = Object.fromEntries(FACET_DEFS.map(f => [f.id, new Map()]));

    for (const release of allMountedReleases()) {
        for (const def of FACET_DEFS) {
            for (const value of def.valuesOf(release)) {
                counts[def.id].set(value, (counts[def.id].get(value) || 0) + 1);
            }
        }
    }

    return counts;
}

function renderFacets() {
    const container = document.getElementById('facets');
    const counts = computeFacetCounts();
    container.innerHTML = '';

    const anyValues = FACET_DEFS.some(def => counts[def.id].size);
    if (!anyValues) {
        container.innerHTML = `<div class="facet-empty">expand a release group to see filters</div>`;
        return;
    }

    for (const def of FACET_DEFS) {
        const values = [...counts[def.id].entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
        if (!values.length) continue;

        const group = document.createElement('div');
        group.className = 'facet-group';
        group.innerHTML = `<h4 class="text default facet-group-title">${def.label}</h4>`;

        for (const [value, count] of values) {
            const state = facetStateOf(def.id, value);
            const option = document.createElement('button');
            option.type = 'button';
            option.className = `facet-option ${state}`;
            option.title = 'click to include, again to exclude, again to reset';

            const marker = document.createElement('span');
            marker.className = 'facet-marker';
            marker.textContent = FACET_MARKERS[state];

            const labelSpan = document.createElement('span');
            labelSpan.className = 'facet-option-label';
            labelSpan.textContent = value;

            const countSpan = document.createElement('span');
            countSpan.className = 'facet-option-count';
            countSpan.textContent = count;

            option.addEventListener('click', () => {
                cycleFacetState(def.id, value);
                notifyFilterStateChange();
            });

            option.append(marker, labelSpan, countSpan);
            group.appendChild(option);
        }

        container.appendChild(group);
    }
}



// render the empty state on first load rather than leaving a blank column until a search
renderFacets();

function updateResultsSummary() {
    const summary = document.getElementById('results-summary');
    const total = allMountedReleases().length;

    if (!total) {
        summary.textContent = document.querySelectorAll('.results-box.release-group-result').length
            ? 'expand a release group to list releases'
            : 'no search yet';
        return;
    }

    const visible = document.querySelectorAll('.releases-table tbody tr.release-row').length;
    summary.textContent = visible === total
        ? `${total} releases`
        : `${visible} of ${total} releases`;
}



function buildReleasesGrid(releases, releaseGroupId, artistId, releaseGroupContext) {
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
            if (!releaseMatchesFilters(release, searchText)) continue;

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
            actionCell.innerHTML = `<h4 class="text green releaseAddButton">Find</h4>`;
            actionCell.querySelector('.releaseAddButton').addEventListener('click', async (e) => {
                e.stopPropagation();

                const expected = buildExpectedFromRelease(release, releaseGroupContext);
                const editionSuffix = expected.edition_tags.length ? ` [${expected.edition_tags.join(', ')}]` : '';
                await openCandidatesPanel(
                    expected,
                    `${releaseGroupContext.artist} - ${expected.album}${editionSuffix}`
                );
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
    mountedReleaseGrids.add({ rerender, releases });

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
    // carried down into the releases grid so each row can build a soulseek search for itself
    const releaseGroupContext = { artist, album: title, year, releaseGroupId, artistId };
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
                <button class="text default addButton" type="button">Find</button>
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
        await openCandidatesPanel(
            buildExpectedFromReleaseGroup(releaseGroupContext),
            `${artist} - ${title}`
        );
    });

    if (releases && releases.length) {
        const releasesContainer = div.querySelector('.release-group-releases');
        const toggleButton = div.querySelector('.releases-toggle-button');
        releasesContainer.appendChild(buildReleasesGrid(releases, releaseGroupId, artistId, releaseGroupContext));

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
                releasesContainer.appendChild(buildReleasesGrid(fetchedReleases, releaseGroupId, artistId, releaseGroupContext));

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
