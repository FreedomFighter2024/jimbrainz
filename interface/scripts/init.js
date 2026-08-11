import {convertTime, sleep} from './utils.js';

async function pingMusicbrainz() {
    const response = await fetch(`/jimbrainz/search_musicbrainz/ping`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to connect to MusicBrainz');
    }
    return response.json();
}
async function checkMusicbrainzPing() {
    try {
        addConnectionToInterface(
            "musicbrainz",
            "pending",
            "loading..."
        )
        const musicbrainz_ping_response = await pingMusicbrainz();
        if(musicbrainz_ping_response.status.toLowerCase() == "ok"){
            console.log("musicbrainz configured and ping responded with OK")
            musicbrainz_ping_response.code = "connected"
            musicbrainz_ping_response.status = "ok"
        }
        else if(musicbrainz_ping_response.status.toLowerCase() == "failed"){
            console.log("musicbrainz ping responded with FAILED")
        }
        else{
            console.log("Unexpected musicbrainz ping response, consider it unconfigured:", musicbrainz_ping_response)
            musicbrainz_ping_response.code = "UNEXPECTED"
            musicbrainz_ping_response.status = "failed"
        }
        addConnectionToInterface(
            "musicbrainz",
            musicbrainz_ping_response.status,
            musicbrainz_ping_response.code
        )
        return musicbrainz_ping_response
    } catch (error) {
        console.log("Musicbrainz ping error")
        addConnectionToInterface(
            "musicbrainz",
            "failed",
            "CONNECTION_ERROR"
        )
        return {"status": "failed", "error": "Musicbrainz ping error", "code": "CONNECTION_ERROR"}
    }

}

async function pingSlskd() {
    const response = await fetch(`/jimbrainz/monitor_slskd/ping`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to connect to Slskd');
    }
    return response.json();
}
async function checkSlskdPing() {
    try {
        addConnectionToInterface(
            "slskd",
            "pending",
            "loading..."
        )
        const slskd_ping_response = await pingSlskd();
        if(slskd_ping_response.status.toLowerCase() == "ok"){
            console.log("Slskd configured and ping responded with OK")
            slskd_ping_response.code = "connected"
            slskd_ping_response.status = "ok"
        }
        else if(slskd_ping_response.status.toLowerCase() == "failed"){
            console.log("Slskd configured but ping responded with FAILED")
        }
        else{
            console.log("Unexpected slskd ping response, consider it unconfigured:", slskd_ping_response)
            slskd_ping_response.code = "UNEXPECTED"
            slskd_ping_response.status = "failed"
        }
        addConnectionToInterface(
            "slskd",
            slskd_ping_response.status,
            slskd_ping_response.code
        )
        return slskd_ping_response
    } catch (error) {
        console.log("Slskd ping didnt respond, slskd not configured")
        addConnectionToInterface(
            "slskd",
            "failed",
            "CONNECTION_ERROR"
        )
        return {"status": "failed", "error": "Slskd ping didnt respond, slskd not configured", "code": "CONNECTION_ERROR"}
    }
}

function addConnectionToInterface(
    connectionName, //slskd //musicbrainz
    connectionStatus,
    connectionStatusCode
) {
    let connectionElement = document.getElementById("general-connection-status")

    if(document.querySelector(`.connection-item:has(.connection-info):has(.connection-info-name.${connectionName})`)) {
        console.log(`Connection ${connectionName} already exists, updating status`)
        const existingConnection = document.querySelector(`.connection-item:has(.connection-info):has(.connection-info-name.${connectionName})`);
        existingConnection.querySelector('.connection-info').className = `connection-info ${connectionStatus}`;
        existingConnection.querySelector('.connection-info-code').textContent = `--${connectionStatusCode}--`;
        return;
    }

    let connectorLineElement = document.createElement("div");
    connectorLineElement.className = "connection-connector-line";
    connectorLineElement.innerHTML = `

    `

    let connectionItem = document.createElement('div');
    connectionItem.className = "connection-item";
    connectionItem.innerHTML = `

        <div class="connection-info ${connectionStatus}">
            <h4 class="connection-info-name text white ${connectionName}">⠀</h4>
            <h4 class="connection-info-line text white">&nbsp;[${connectionName}]&nbsp;</h4>
            <h4 class="connection-info-code text">--${connectionStatusCode}--</h4>
        </div>
    `
    connectionElement.appendChild(connectionItem);
    connectionElement.appendChild(connectorLineElement);
}


function appendEvent(eventType, content, src) {
    const eventLogElement = document.getElementById('logs-scrollable');
    const eventItem = document.createElement('div');
    eventItem.className = 'event-item';
    const timeString = convertTime(new Date());
    const srcMarkup = src
        ? `<h5 class="text default-secondary event-src ${src.toLowerCase()}">${src}</h5>`
        : '';

    eventItem.innerHTML =
    `
        <div class="first-row">
            <h5 class="text default event-type ${eventType}">${eventType}</h5>
            <h5 class="text white event-time">[${timeString}]&nbsp;&nbsp;</h5>
            ${srcMarkup}
        </div>
        <div class="second-row">
            <h4 class="text event-content-indent">└─╲</h5>
            <h5 class="text default-secondary event-content">${content}</h5>
        </div>
    `;
    eventLogElement.prepend(eventItem);
    return eventItem;
}


let eventSource = null;

async function initEventStream({ refreshServerConfig }) {
    const eventLogElement = document.getElementById('logs-scrollable');

    const serverConfig = await refreshServerConfig();

    if (serverConfig === undefined) {
        appendEvent('WARNING', 'Couldnt load server config');
    }

    else {
        appendEvent('INFO', 'Loaded server config', 'slskd');
    }

    eventSource = new EventSource('/jimbrainz/interface_logs/interface_logs');
    eventSource.onerror = function(error){
        const eventItem = appendEvent('ERROR', 'Failed to connect to backend');

        // collapse repeats of the same message instead of flooding the log
        if (eventLogElement.children[1] &&
            eventLogElement.children[1].children[1].innerHTML == eventItem.children[1].innerHTML) {
            console.log("next element same as last")
            eventLogElement.removeChild(eventLogElement.children[1])
        }
    }

    eventSource.onmessage = async function(event) {
        const data = JSON.parse(event.data);
        appendEvent(data.event_type, data.event_content, data.src);
    }
}

export async function init({ refreshServerConfig }) {

    await initEventStream({ refreshServerConfig })

    await sleep(100)

    const [musicbrainzPingResponse, slskdPingResponse] = await Promise.all([
        checkMusicbrainzPing(), checkSlskdPing()]);

    console.log(musicbrainzPingResponse, slskdPingResponse)
}

window.addEventListener('beforeunload', () => {
    if (eventSource) {
        eventSource.close();
    }
});
