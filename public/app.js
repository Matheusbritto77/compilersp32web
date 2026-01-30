/**
 * ESP32 Web Flasher - Frontend Logic
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
    buildTime: document.getElementById('buildTime'),
    buildsList: document.getElementById('buildsList')
};

let selectedFile = null;
let currentBuildId = null;
let ws = null;

// Initialize
init();

function init() {
    setupEventListeners();
    loadRecentBuilds();
    connectWebSocket();
}

function setupEventListeners() {
    // Click on zone to trigger file input
    elements.uploadZone.addEventListener('click', () => elements.fileInput.click());

    // File selection
    elements.fileInput.addEventListener('change', (e) => {
        handleFileSelect(e.target.files[0]);
    });

    // Drag & Drop
    elements.uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.add('drag-over');
    });

    elements.uploadZone.addEventListener('dragleave', () => {
        elements.uploadZone.classList.remove('drag-over');
    });

    elements.uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.remove('drag-over');
        handleFileSelect(e.dataTransfer.files[0]);
    });

    // Remove file
    elements.removeFile.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedFile = null;
        elements.fileInput.value = '';
        elements.fileInfo.style.display = 'none';
        elements.uploadZone.classList.remove('has-file');
        elements.buildBtn.disabled = true;
    });

    // Build button
    elements.buildBtn.addEventListener('click', startBuild);
}

function handleFileSelect(file) {
    if (!file) return;
    if (!file.name.endsWith('.zip')) {
        alert('Por favor, selecione um arquivo .zip');
        return;
    }

    selectedFile = file;
    elements.fileName.textContent = file.name;
    elements.fileInfo.style.display = 'flex';
    elements.uploadZone.classList.add('has-file');
    elements.buildBtn.disabled = false;
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.buildId === currentBuildId) {
            appendLog(data.message, data.type);
        }
    };

    ws.onclose = () => {
        setTimeout(connectWebSocket, 3000);
    };
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

    // Reset UI
    elements.buildSection.style.display = 'block';
    elements.flashSection.style.display = 'none';
    elements.terminalOutput.textContent = '';
    elements.progressFill.style.width = '10%';
    elements.progressText.textContent = 'Enviando projeto...';
    elements.buildBtn.disabled = true;

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        if (response.ok) {
            currentBuildId = result.buildId;
            elements.progressFill.style.width = '20%';
            elements.progressText.textContent = 'Compilando no servidor...';
            pollBuildStatus(currentBuildId);
        } else {
            throw new Error(result.error || 'Erro ao iniciar build');
        }
    } catch (error) {
        alert(error.message);
        elements.buildBtn.disabled = false;
    }
}

async function pollBuildStatus(buildId) {
    const interval = setInterval(async () => {
        try {
            const response = await fetch(`/api/build/${buildId}`);
            const data = await response.json();

            if (data.status === 'success') {
                clearInterval(interval);
                onBuildSuccess(data);
            } else if (data.status === 'failed') {
                clearInterval(interval);
                onBuildError(data.error);
            }
        } catch (e) {
            console.error('Erro ao consultar status:', e);
        }
    }, 2000);
}

function onBuildSuccess(data) {
    elements.progressFill.style.width = '100%';
    elements.progressText.textContent = 'Build concluído!';
    elements.buildStatus.innerHTML = '<span class="status-indicator status-success"></span><span class="status-text">Sucesso</span>';

    // Mostra seção de flash
    elements.flashSection.style.display = 'block';
    elements.buildTime.textContent = `Tempo: ${((data.endTime - data.startTime) / 1000).toFixed(1)}s`;

    // Lista binários
    elements.binariesList.innerHTML = '';
    const builds = data.binaries;

    // Configura o ESP Web Tools
    // O ESP Web Tools espera um manifesto ou links diretos
    const manifest = {
        name: "ESP32 Firmware",
        builds: [
            {
                chipFamily: data.target.toUpperCase().replace('-', ''),
                parts: []
            }
        ]
    };

    // Mapeamento padrão de endereços ESP-IDF
    const addrMap = {
        'bootloader.bin': 0x1000,
        'partition-table.bin': 0x8000,
        'ota_data_initial.bin': 0x9000,
        'project.bin': 0x10000 // Geralmente o binário principal
    };

    Object.entries(builds).forEach(([name, url]) => {
        const item = document.createElement('div');
        item.className = 'binary-item';
        item.innerHTML = `
            <div class="binary-info">
                <span class="binary-name">${name}</span>
            </div>
            <a href="${url}" download class="btn btn-icon" title="Download">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
            </a>
        `;
        elements.binariesList.appendChild(item);

        // Adiciona ao manifesto se for um arquivo conhecido
        let addr = addrMap[name];
        if (!addr && name.endsWith('.bin') && !name.includes('bootloader') && !name.includes('partition')) {
            addr = 0x10000; // Assume app principal se não for boot/partition
        }

        if (addr !== undefined) {
            manifest.builds[0].parts.push({
                path: window.location.origin + url,
                offset: addr
            });
        }
    });

    // Atualiza botão de flash
    elements.espInstallButton.manifest = manifest;

    loadRecentBuilds();
    elements.buildBtn.disabled = false;
}

function onBuildError(error) {
    elements.progressFill.style.width = '100%';
    elements.progressFill.style.background = 'var(--error)';
    elements.progressText.textContent = 'Erro na compilação';
    elements.buildStatus.innerHTML = '<span class="status-indicator status-error"></span><span class="status-text">Falha</span>';
    elements.buildBtn.disabled = false;
    alert('Erro: ' + error);
}

async function loadRecentBuilds() {
    try {
        const response = await fetch('/api/builds');
        const builds = await response.json();

        if (builds.length === 0) return;

        elements.buildsList.innerHTML = '';
        builds.reverse().forEach(build => {
            const item = document.createElement('div');
            item.className = 'build-item';
            const date = new Date(build.startTime).toLocaleString();
            item.innerHTML = `
                <div class="build-item-info">
                    <span class="build-item-status status-${build.status}"></span>
                    <div>
                        <div class="build-item-id">${build.id.substring(0, 8)}... (${build.target})</div>
                        <div class="build-item-date">${date}</div>
                    </div>
                </div>
                <div class="build-item-badge ${build.status}">${build.status}</div>
            `;
            item.onclick = () => {
                if (build.status === 'success') {
                    currentBuildId = build.id;
                    onBuildSuccess(build);
                    window.scrollTo({ top: elements.flashSection.offsetTop - 100, behavior: 'smooth' });
                }
            };
            elements.buildsList.appendChild(item);
        });
    } catch (e) {
        console.error('Erro ao carregar builds:', e);
    }
}
