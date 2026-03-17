import {convertTime, sleep} from './utils.js';

async function pingMusicbrainz() {
    const response = await fetch(`/lidbrainz/search_musicbrainz/ping`);

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
            // if(musicbrainz_ping_response.code == 403){
            //     console.log(musicbrainz_ping_response.error)
            // }
            // if(musicbrainz_ping_response.code == "VALUE_ERROR"){
            //     console.log(musicbrainz_ping_response.error)
            // }
            // if(musicbrainz_ping_response.code == "UNKNOWN_ERROR"){
            //     console.log(musicbrainz_ping_response.error)
            // }
            // if(musicbrainz_ping_response.code == 401){
            //     console.log(musicbrainz_ping_response.error)
            // }
            // if(musicbrainz_ping_response.code == "CONNECTION_ERROR"){
            //     console.log(musicbrainz_ping_response.error)
            // }
            // if(musicbrainz_ping_response.code == 429){
            //     console.log(musicbrainz_ping_response.error)
            // }
            // if(musicbrainz_ping_response.code == 503){
            //     console.log(musicbrainz_ping_response.error)
            // }
            // if(musicbrainz_ping_response.code == "UNKNOWN_HTTP_ERROR"){
            //     console.log(musicbrainz_ping_response.error)
            // }
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

async function pingLidarr() {
    const response = await fetch(`/lidbrainz/add_to_lidarr/ping`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to connect to Lidarr');
    }
    return response.json();
}
async function checkLidarrPing() {
    try {
        addConnectionToInterface(
            "lidarr",
            "pending",
            "loading..."
        )
        const lidarr_ping_response = await pingLidarr();
        if(lidarr_ping_response.status.toLowerCase() == "ok"){
            console.log("Lidarr configured and ping responded with OK")
            lidarr_ping_response.code = "connected"
            lidarr_ping_response.status = "ok"
        }
        else if(lidarr_ping_response.status.toLowerCase() == "failed"){
            console.log("Lidarr configured but ping responded with FAILED")
            // if(lidarr_ping_response.code == 401){
            //     console.log(lidarr_ping_response.error)
            // }
            // if(lidarr_ping_response.code == "VALUE_ERROR"){
            //     console.log(lidarr_ping_response.error)
            // }
            // if(lidarr_ping_response.code == "NO_STATE"){
            //     console.log(lidarr_ping_response.error)
            // }
            // if(lidarr_ping_response.code == "UNKNOWN_ERROR"){
            //     console.log(lidarr_ping_response.error)
            // }
            // if(lidarr_ping_response.code == "UNKNOWN_HTTP_ERROR"){
            //     console.log(lidarr_ping_response.error)
            // }
        }
        else{
            console.log("Unexpected lidarr ping response, consider it unconfigured:", lidarr_ping_response)
            lidarr_ping_response.code = "UNKNOWN"
            lidarr_ping_response.status = "failed"
        }
        addConnectionToInterface(
            "lidarr",
            lidarr_ping_response.status,
            lidarr_ping_response.code
        )
        return lidarr_ping_response
    } catch (error) {
        console.log("Lidarr ping didnt respond at all, url configured incorrectly")
        addConnectionToInterface(
            "lidarr",
            "failed",
            "CONNECTION_ERROR"
        )
        return {"status": "failed", "error": "Lidarr ping didnt respond at all, url configured incorrectly", "code": "CONNECTION_ERROR"}
    }
}

async function pingSlskd() {
    const response = await fetch(`/lidbrainz/monitor_slskd/ping`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to connect to Slskd');
    }
    return response.json();
}
async function checkSlskdPing() {
    try {
        // addConnectionToInterface(
        //     "slskd",
        //     "pending",
        //     "loading..."
        // )
        const slskd_ping_response = await pingSlskd();
        if(slskd_ping_response.status.toLowerCase() == "ok"){
            console.log("Slskd configured and ping responded with OK")
            slskd_ping_response.code = "connected"
            slskd_ping_response.status = "ok"
        }
        else if(slskd_ping_response.status.toLowerCase() == "failed"){
            // console.log("Slskd configured but ping responded with FAILED")
            // if(slskd_ping_response.code == 401){
            //     console.log(slskd_ping_response.error)
            // }
            // if(slskd_ping_response.code == 502){
            //     console.log(slskd_ping_response.error)
            // }
            // if(slskd_ping_response.code == "CONNECTION_ERROR"){
            //     console.log(slskd_ping_response.error)
            // }
            // if(slskd_ping_response.code == "NO_STATE"){
            //     console.log(slskd_ping_response.error)
            // }
            // if(slskd_ping_response.code == "UNKNOWN_ERROR"){
            //     console.log(slskd_ping_response.error)
            // }
            // if(slskd_ping_response.code == "UNKNOWN_HTTP_ERROR"){
            //     console.log(slskd_ping_response.error)
            // }
        }
        else{
            console.log("Unexpected slskd ping response, consider it unconfigured:", slskd_ping_response)
            slskd_ping_response.code = "UNEXPECTED"
            slskd_ping_response.status = "failed"
            return {"status": "failed", "error": "Slskd ping didnt respond, slskd not configured", "code": "CONNECTION_ERROR"}
        }
        addConnectionToInterface(
            "slskd",
            slskd_ping_response.status,
            slskd_ping_response.code
        )
        return slskd_ping_response
    } catch (error) {
        console.log("Slskd ping didnt respond, slskd not configured")
        // addConnectionToInterface(
        //     "slskd",
        //     "failed",
        //     "CONNECTION_ERROR"
        // )
        return {"status": "failed", "error": "Slskd ping didnt respond, slskd not configured", "code": "CONNECTION_ERROR"}
    }
}

function addConnectionToInterface(
    connectionName, //slskd //lidarr //musicbrainz
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
        // <div class="connection-logo-container">
        //     <img src="./assets/${connectionName}.png" alt="${connectionName} logo" class="connection-logo">
        // </div>
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


let lidbrainzEventSource = null; 

async function initLidarrInfo({ refreshLidarrInfo }) {
    const lidbrainzEventLog = document.getElementById('logs-scrollable');
   
    let lidarrUrl = await refreshLidarrInfo();

    if(lidarrUrl == undefined){
        const eventItem = document.createElement('div');
        eventItem.className = 'event-item';
        const timeString = convertTime(new Date());
        eventItem.innerHTML = 
        `
            <div class="first-row">
                <h5 class="text default event-type WARNING">WARNING</h5>
                <h5 class="text white event-time">[${timeString}]</h5>
            </div>
            <div class="second-row">
                <h4 class="text event-content-indent">└─╲</h5>
                <h5 class="text default-secondary event-content">Couldnt configure Lidarr</h5>
            </div>
        `;
        lidbrainzEventLog.prepend(eventItem);
    }

    if(lidarrUrl != undefined){
        const eventItem = document.createElement('div');
        eventItem.className = 'event-item';
        const timeString = convertTime(new Date());
        eventItem.innerHTML = 
        `
            <div class="first-row">
                <h5 class="text default event-type INFO">INFO</h5>
                <h5 class="text white event-time">[${timeString}]&nbsp;&nbsp;</h5>
                <h5 class="text default-secondary event-src lidarr">lidarr</h5>
            </div>
            <div class="second-row">
                <h4 class="text event-content-indent">└─╲</h5>
                <h5 class="text default-secondary event-content">Fetched Lidarr system info</h5>
            </div>
        `;
        lidbrainzEventLog.prepend(eventItem); 
    }
    lidbrainzEventSource = new EventSource('/lidbrainz/interface_logs/interface_logs');
    lidbrainzEventSource.onerror = function(error){
        const eventItem = document.createElement('div');
        eventItem.className = 'event-item';
        const timeString = convertTime(new Date());
        eventItem.innerHTML = 
        `
            <div class="first-row">
                <h5 class="text default event-type ERROR">ERROR</h5>
                <h5 class="text white event-time">[${timeString}]</h5>
            </div>
            <div class="second-row">
                <h4 class="text event-content-indent">└─╲</h5>
                <h5 class="text default-secondary event-content">Failed to connect to backend</h5>
            </div>
        `;
        if(lidbrainzEventLog.children[0].children[1].innerHTML == eventItem.children[1].innerHTML){
            console.log("next element same as last")
            lidbrainzEventLog.removeChild(lidbrainzEventLog.children[0])
            lidbrainzEventLog.prepend(eventItem);
        }
        else{
            lidbrainzEventLog.prepend(eventItem);
        }
    }

    lidbrainzEventSource.onmessage = async function(event) {
        const data = JSON.parse(event.data);

        console.log(lidarrUrl)

        const eventItem = document.createElement('div');
        eventItem.className = 'event-item';
        const timeString = convertTime(new Date());
        eventItem.innerHTML = 
        `
            <div class="first-row">
                <h5 class="text default event-type ${data.event_type}">${data.event_type}</h5>
                <h5 class="text white event-time">[${timeString}]&nbsp;&nbsp;</h5>
                <h5 class="text default-secondary event-src ${data.src.toLowerCase()}">${data.src}</h5>
            </div>
            <div class="second-row">
                <h4 class="text event-content-indent">└─╲</h5>
                <h5 class="text default-secondary event-content">${data.event_content}</h5>
            </div>
        `;
        lidbrainzEventLog.prepend(eventItem);
    }
}

export async function init({ refreshLidarrInfo }) {

    await initLidarrInfo({ refreshLidarrInfo })

    await sleep(100)

    const [musicbrainzPingResponse , lidarrPingResponse , slskdPingResponse] = await Promise.all([
        checkMusicbrainzPing(), checkLidarrPing(), checkSlskdPing()]);

    console.log(musicbrainzPingResponse, lidarrPingResponse, slskdPingResponse)
}

window.addEventListener('beforeunload', () => {
    if (lidbrainzEventSource) {
        lidbrainzEventSource.close();
    }
});



