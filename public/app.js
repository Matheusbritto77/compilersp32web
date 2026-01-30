/**
 * ESP32 Web Flasher - Frontend Logic (v2 with Serial Monitor)
 */

const elements = {
    uploadZone: document.getElementById('uploadZone'),
    fileInput: document.getElementById('fileInput'),
    fileInfo: document.getElementById('fileInfo'),
    fileName: document.getElementById('fileName'),
    removeFile: document.getElementById('removeFile'),
    buildBtn: document.getElementById('buildBtn'),
    targetSelect: document.getElementById('targetSelect'),
    buildSection: document.getElementById('buildSection'),
    buildStatus: document.getElementById('buildStatus'),
    progressFill: document.querySelector('.progress-fill'),
    progressText: document.getElementById('progressText'),
    terminalOutput: document.getElementById('terminalOutput'),
    terminalBody: document.getElementById('terminalBody'),
    flashSection: document.getElementById('flashSection'),
    binariesList: document.getElementById('binariesList'),
    espInstallButton: document.getElementById('espInstallButton'),
    deviceInfoBadge: document.getElementById('deviceInfoBadge'),
    connectedChipName: document.getElementById('connectedChipName'),
    deviceDetails: document.getElementById('deviceDetails'),
    infoChip: document.getElementById('infoChip'),
    infoMac: document.getElementById('infoMac'),
    infoFeatures: document.getElementById('infoFeatures'),
    monitorSection: document.getElementById('monitorSection'),
    monitorOutput: document.getElementById('monitorOutput'),
    monitorBody: document.getElementById('monitorBody'),
    connectSerialBtn: document.getElementById('connectSerialBtn'),
    clearMonitorBtn: document.getElementById('clearMonitorBtn'),
    baudRate: document.getElementById('baudRate'),
    buildsList: document.getElementById('buildsList')
};

let selectedFile = null;
let currentBuildId = null;
let ws = null;
let serialPort = null;
let serialReader = null;

// Initialize
init();

function init() {
    setupEventListeners();
    loadRecentBuilds();
    connectWebSocket();
}

function setupEventListeners() {
    elements.uploadZone.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', (e) => handleFileSelect(e.target.files[0]));

    elements.uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); elements.uploadZone.classList.add('drag-over'); });
    elements.uploadZone.addEventListener('dragleave', () => elements.uploadZone.classList.remove('drag-over'));
    elements.uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.remove('drag-over');
        handleFileSelect(e.dataTransfer.files[0]);
    });

    elements.removeFile.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedFile = null;
        elements.fileInput.value = '';
        elements.fileInfo.style.display = 'none';
        elements.uploadZone.classList.remove('has-file');
        elements.buildBtn.disabled = true;
    });

    elements.buildBtn.addEventListener('click', startBuild);
    elements.clearMonitorBtn.addEventListener('click', () => elements.monitorOutput.textContent = '');
    elements.connectSerialBtn.addEventListener('click', toggleSerial);

    // ESC Web Tools Events
    elements.espInstallButton.addEventListener('install-success', () => {
        appendLog('\n✅ Gravação concluída! Abrindo monitor serial...', 'success');
        elements.monitorSection.style.display = 'block';
        setTimeout(connectSerial, 1000);
    });
}

function handleFileSelect(file) {
    if (!file || !file.name.endsWith('.zip')) return alert('Selecione um ZIP');
    selectedFile = file;
    elements.fileName.textContent = file.name;
    elements.fileInfo.style.display = 'flex';
    elements.uploadZone.classList.add('has-file');
    elements.buildBtn.disabled = false;
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.buildId === currentBuildId) appendLog(data.message, data.type);
    };
    ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

function appendLog(message, type) {
    const span = document.createElement('span');
    span.className = `log-${type}`;
    span.textContent = message;
    elements.terminalOutput.appendChild(span);
    elements.terminalBody.scrollTop = elements.terminalBody.scrollHeight;
}

async function startBuild() {
    if (!selectedFile) return;
    const formData = new FormData();
    formData.append('project', selectedFile);
    formData.append('target', elements.targetSelect.value);

    elements.buildSection.style.display = 'block';
    elements.flashSection.style.display = 'none';
    elements.monitorSection.style.display = 'none';
    elements.terminalOutput.textContent = '';
    elements.progressFill.style.width = '10%';
    elements.progressText.textContent = 'Enviando...';
    elements.buildBtn.disabled = true;

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        currentBuildId = result.buildId;
        pollBuildStatus(currentBuildId);
    } catch (e) {
        alert(e.message);
        elements.buildBtn.disabled = false;
    }
}

async function pollBuildStatus(buildId) {
    const timer = setInterval(async () => {
        const res = await fetch(`/api/build/${buildId}`);
        const data = await res.json();
        if (data.status === 'success') { clearInterval(timer); onBuildSuccess(data); }
        else if (data.status === 'failed') { clearInterval(timer); onBuildError(data.error); }
    }, 2000);
}

function onBuildSuccess(data) {
    elements.progressFill.style.width = '100%';
    elements.progressText.textContent = 'Build OK!';
    elements.buildStatus.innerHTML = '<span class="status-indicator status-success"></span><span>Sucesso</span>';
    elements.flashSection.style.display = 'block';
    elements.binariesList.innerHTML = '';

    const manifest = {
        name: "ESP32 Firmware",
        builds: [{ chipFamily: data.target.toUpperCase().replace('-', ''), parts: [] }]
    };

    const addrMap = { 'bootloader.bin': 0x1000, 'partition-table.bin': 0x8000, 'project.bin': 0x10000 };

    Object.entries(data.binaries).forEach(([name, url]) => {
        const item = document.createElement('div');
        item.className = 'binary-item';
        item.innerHTML = `<span>${name}</span><a href="${url}" download class="btn btn-icon">⬇️</a>`;
        elements.binariesList.appendChild(item);

        let addr = addrMap[name] || (name.endsWith('.bin') && !name.includes('bootloader') && !name.includes('partition') ? 0x10000 : null);
        if (addr !== null) manifest.builds[0].parts.push({ path: window.location.origin + url, offset: addr });
    });

    elements.espInstallButton.manifest = manifest;
    loadRecentBuilds();
    elements.buildBtn.disabled = false;
}

function onBuildError(err) {
    elements.progressFill.style.background = 'var(--error)';
    elements.progressText.textContent = 'Erro';
    elements.buildStatus.innerHTML = '<span class="status-indicator status-error"></span><span>Falha</span>';
    elements.buildBtn.disabled = false;
    alert(err);
}

// --- Serial Monitor Logic ---

async function toggleSerial() {
    if (serialPort) {
        await disconnectSerial();
    } else {
        await connectSerial();
    }
}

async function connectSerial() {
    try {
        if (!navigator.serial) return alert('Web Serial não suportado/habilitado. Use HTTPS.');

        serialPort = await navigator.serial.requestPort();
        await serialPort.open({ baudRate: parseInt(elements.baudRate.value) });

        elements.connectSerialBtn.textContent = 'Desconectar';
        elements.connectSerialBtn.classList.replace('btn-primary', 'btn-error');
        elements.monitorSection.style.display = 'block';

        readSerial();
    } catch (e) {
        console.error(e);
        serialPort = null;
    }
}

async function disconnectSerial() {
    if (serialReader) {
        await serialReader.cancel();
        serialReader = null;
    }
    if (serialPort) {
        await serialPort.close();
        serialPort = null;
    }
    elements.connectSerialBtn.textContent = 'Conectar Monitor';
    elements.connectSerialBtn.classList.replace('btn-error', 'btn-primary');
}

async function readSerial() {
    while (serialPort && serialPort.readable) {
        serialReader = serialPort.readable.getReader();
        try {
            while (true) {
                const { value, done } = await serialReader.read();
                if (done) break;
                const text = new TextDecoder().decode(value);
                elements.monitorOutput.textContent += text;
                elements.monitorBody.scrollTop = elements.monitorBody.scrollHeight;
                if (elements.monitorOutput.textContent.length > 50000) {
                    elements.monitorOutput.textContent = elements.monitorOutput.textContent.slice(-20000);
                }
            }
        } catch (e) {
            console.error(e);
        } finally {
            serialReader.releaseLock();
        }
    }
}

async function loadRecentBuilds() {
    const res = await fetch('/api/builds');
    const builds = await res.json();
    if (builds.length) {
        elements.buildsList.innerHTML = '';
        builds.reverse().slice(0, 5).forEach(b => {
            const el = document.createElement('div');
            el.className = 'build-item';
            el.innerHTML = `<span>${b.id.slice(0, 8)} (${b.target})</span><small>${b.status}</small>`;
            el.onclick = () => { currentBuildId = b.id; onBuildSuccess(b); };
            elements.buildsList.appendChild(el);
        });
    }
}
