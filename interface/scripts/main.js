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
async function populateMetadataProfiles(profiles) {
    console.log("populating metadata profs")
    const container = document.getElementById('metadata-profile-select');
    container.innerHTML = '';

    profiles.forEach(profile => {
        const metadataProfileElementId = `metadata-profile-${profile.id}`;
        container.innerHTML += 
        `
            <input type="radio" id="${metadataProfileElementId}" name="metadata-profile" value="${profile.id}" ${profile.id === 1 ? 'checked' : ''}>
            <label for="${metadataProfileElementId}">└─╲ ${profile.name}</label>
        `;
    });

    container.addEventListener('change', (event) => {
        const selectedMetadataProfileId = document.querySelector('#metadata-profile-select > input[type="radio"]:checked').value;
    });
}



async function populateQualityProfiles(profiles) {
    console.log("populating quality profs")
    const container = document.getElementById('quality-profile-select');
    container.innerHTML = '';
    const firstProfileId = profiles[0].id;

    profiles.forEach(profile => {
        const qualityProfileElementId = `quality-profile-${profile.id}`;
        container.innerHTML += 
        `
            <input type="radio" id="${qualityProfileElementId}" name="quality-profile" value="${profile.id}" ${profile.id === firstProfileId ? 'checked' : ''}>
            <label for="${qualityProfileElementId}">└─╲ ${profile.name}</label>
        `;
    });

    container.addEventListener('change', (event) => {
        const selectedQualityProfileId = document.querySelector('#quality-profile-select > input[type="radio"]:checked').value;
    });
}



async function populateFolderProfiles(profiles) {
    console.log("populating folders")
    const container = document.getElementById('folder-profile-select');
    container.innerHTML = '';
    const firstProfileId = profiles[0].id;

    profiles.forEach(profile => {
        const folderProfileElementId = `folder-profile-${profile.id}`;
        container.innerHTML += 
        `
            <input type="radio" id="${folderProfileElementId}" name="folder-profile" value="${profile.path}" ${profile.id === firstProfileId ? 'checked' : ''}>
            <label for="${folderProfileElementId}">└─╲ ${profile.name}</label>
        `;
    });

    container.addEventListener('change', (event) => {
        const selectedFolderProfileId = document.querySelector('#folder-profile-select > input[type="radio"]:checked').value;
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



async function handleSearch() {
    const release = releaseSearchInput.value.trim();
    let artist = artistSearchInput.value.trim();

    if(artist.toLowerCase() === "va"){
        artist = "Various Artists"
    }

    let query;
    if (artist && release) {
        query = `releasegroup:${release} AND artist:${artist}`;
    } else if (artist) {
        query = `artist:"${artist}"`;
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



function createReleaseElement(release, releaseGroupId, artistId) {
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
    const disambiguation = release.disambiguation || '';
    const wrapper = document.createElement('div');
    wrapper.className = 'release-wrapper';

    let totalTracks = 0;
    for (let disc of media) {
        totalTracks += (disc.tracks?.length || 0);
    }

    const releaseRow = document.createElement('div');
    releaseRow.className = 'release';
    releaseRow.innerHTML = 
    `
        <div class="shrinkable">
            <h4 class="text white releaseName">└─╲ ▷
                <a href="https://musicbrainz.org/release/${releaseId}" target="_blank" rel="noopener noreferrer">${title}</a>
            &nbsp;</h4>
            <h4 class="text default releaseFormat">[${format}]▷╲</h4>
            <h4 class="text default releaseTracks">(${tracks}),&nbsp;</h4>
            <h4 class="text default-secondary releaseStatus">${status}</h4>
            ${editionTags.map(tag => `<h4 class="text yellow releaseEditionTag" title="${disambiguation}">[${tag}]</h4>`).join('')}
        </div>
        <div class="non-shrinkable">
            ${countryCode ? `<img src="https://flagcdn.com/${countryCode}.svg">` : `<img src="https://upload.wikimedia.org/wikipedia/commons/b/b0/No_flag.svg">`}
            <h4 class="text white releaseCountry">${countryDisplay}&nbsp;¦</h4>
            <h4 class="text white releaseYear">${date}</h4>
            <h4 class="text green releaseAddButton">Add release</h4>
        </div>
    `;

    releaseRow.querySelector('.releaseAddButton').addEventListener('click', async (e) => {
        e.stopPropagation();
        let status

        try {
            status = await handleAddRelease(releaseGroupId, artistId, releaseId);
        } 
        
        catch (error) {
            status = `Add release error: ${error.message}`;
        }
    });

    wrapper.appendChild(releaseRow);

    if (totalTracks > 0) {
        const tracksContainer = document.createElement('div');
        tracksContainer.className = 'release-tracks';

        for (let disc of media) {
            for (let track of (disc.tracks || [])) {
                const { minutes, seconds } = millisecondsToMinutesAndSeconds(track.recording?.length);
                const recordingTitle = track.recording?.title || 'N/A';
                const recordingId = track.recording?.id;
                const lengthStr = minutes === 'N/A' ? 'N/A' : `${minutes}:${seconds.toString().padStart(2, '0')}`;
                const trackDiv = document.createElement('div');
                trackDiv.className = 'track';
                trackDiv.innerHTML = 
                `
                    <h4 class="text default-secondary trackIndent">└─╲ <h4>
                    <h4 class="text default trackNumber">${track.number}.${track.position} : <h4>
                    <h4 class="text white trackName"><a href="https://musicbrainz.org/recording/${recordingId}" target="_blank" rel="noopener noreferrer">${recordingTitle}</a></h4>
                    <h4 class="text white-tertiary trackLength">[${lengthStr}]</h4>
                `;
                tracksContainer.appendChild(trackDiv);
            }
        }

        wrapper.appendChild(tracksContainer);

        releaseRow.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            tracksContainer.classList.toggle('expanded');

            const nameEl = releaseRow.querySelector('.releaseName');
            if (tracksContainer.classList.contains('expanded')) {
                nameEl.innerHTML = `└─╲ ▽
                    <a href="https://musicbrainz.org/release/${releaseId}" target="_blank" rel="noopener noreferrer">${title}</a>
                &nbsp;`;
            }
            else {
                nameEl.innerHTML = `└─╲ ▷
                    <a href="https://musicbrainz.org/release/${releaseId}" target="_blank" rel="noopener noreferrer">${title}</a>
                &nbsp;`;
            }

            checkScrollability();
        });
    }

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
                <h3 class="text white-tertiary releaseGrpType">&nbsp;[${type}] &nbsp;</h3>
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
        releases.forEach(r => releasesContainer.appendChild(createReleaseElement(r,releaseGroupId,artistId)));

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
                fetchedReleases.forEach(r => releasesContainer.appendChild(createReleaseElement(r, releaseGroupId, artistId)));

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
