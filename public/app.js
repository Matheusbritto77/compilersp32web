// ============================================
// ESP32 Web IDE - Complete JavaScript
// ============================================

const API_BASE = window.location.origin;
let ws = null;
let currentProject = null;
let currentBuildId = null;
let monacoEditor = null;
let openFiles = new Map();
let serialPort = null;
let serialReader = null;

// ============================================
// Initialization
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    initWebSocket();
    initEventListeners();
    initTabs();
    initMonaco();
    loadProjects();
});

function initWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleLogMessage(data);
    };

    ws.onclose = () => {
        setTimeout(initWebSocket, 3000);
    };
}

function handleLogMessage(data) {
    const terminal = document.getElementById('terminalOutput');
    const line = document.createElement('span');
    line.className = `line-${data.type}`;
    line.textContent = data.message;
    terminal.appendChild(line);

    // Auto-scroll
    const body = document.getElementById('terminalBody');
    body.scrollTop = body.scrollHeight;

    // Update status
    if (data.type === 'success') {
        updateStatus('Concluído', 'success');
    } else if (data.type === 'error') {
        updateStatus('Erro', 'error');
    }
}

function updateStatus(text, type = 'ready') {
    const indicator = document.getElementById('statusIndicator');
    indicator.querySelector('.text').textContent = text;
    indicator.className = `status-indicator ${type}`;
}

// ============================================
// Event Listeners
// ============================================

function initEventListeners() {
    // Upload
    document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
    });

    document.getElementById('fileInput').addEventListener('change', handleFileUpload);

    // Actions
    document.getElementById('btnSetTarget').addEventListener('click', showTargetModal);
    document.getElementById('btnBuild').addEventListener('click', buildProject);
    document.getElementById('btnQuickBuild').addEventListener('click', buildProject);
    document.getElementById('btnClean').addEventListener('click', cleanProject);
    document.getElementById('btnFlash').addEventListener('click', () => switchTab('flash'));
    document.getElementById('btnMonitor').addEventListener('click', () => switchTab('monitor'));

    // Analysis
    document.getElementById('btnSize').addEventListener('click', () => runCommand('size'));
    document.getElementById('btnSizeComponents').addEventListener('click', () => runCommand('size-components'));
    document.getElementById('btnSizeFiles').addEventListener('click', () => runCommand('size-files'));

    // Configuration
    document.getElementById('btnMenuconfig').addEventListener('click', () => {
        switchTab('config');
        loadConfig();
    });
    document.getElementById('btnPartitions').addEventListener('click', () => {
        switchTab('partitions');
        loadPartitions();
    });
    document.getElementById('btnReconfigure').addEventListener('click', () => runCommand('reconfigure'));

    // Config
    document.getElementById('saveConfig').addEventListener('click', saveConfig);
    document.getElementById('configSearch').addEventListener('input', filterConfig);

    // Partitions
    document.getElementById('addPartition').addEventListener('click', addPartition);
    document.getElementById('savePartitions').addEventListener('click', savePartitions);

    // Terminal
    document.getElementById('clearTerminal').addEventListener('click', clearTerminal);

    // Monitor
    document.getElementById('connectSerial').addEventListener('click', toggleSerial);
    document.getElementById('clearMonitor').addEventListener('click', clearMonitor);
    document.getElementById('downloadLogs').addEventListener('click', downloadLogs);
    document.getElementById('sendSerial').addEventListener('click', sendSerialData);
    document.getElementById('serialInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendSerialData();
    });

    // Target Modal
    document.getElementById('closeTargetModal').addEventListener('click', hideTargetModal);
    document.querySelectorAll('.target-option').forEach(btn => {
        btn.addEventListener('click', () => {
            selectTarget(btn.dataset.target);
            hideTargetModal();
        });
    });

    // Sidebar toggle
    document.getElementById('toggleSidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('collapsed');
    });
}

// ============================================
// Tabs
// ============================================

function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
        });
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    document.querySelector(`.tab[data-tab="${tabId}"]`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');
}

// ============================================
// Project Upload
// ============================================

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    updateStatus('Enviando...', 'building');
    clearTerminal();
    appendTerminal(`📤 Enviando projeto: ${file.name}...\n`, 'info');

    const formData = new FormData();
    formData.append('project', file);

    try {
        const response = await fetch(`${API_BASE}/api/project/upload`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.success) {
            currentProject = data.project;
            appendTerminal(`✅ Projeto carregado: ${data.project.name}\n`, 'success');
            updateProjectUI();
            enableButtons();
            loadFileTree();
        } else {
            appendTerminal(`❌ Erro: ${data.error}\n`, 'error');
        }
    } catch (err) {
        appendTerminal(`❌ Erro no upload: ${err.message}\n`, 'error');
    }

    updateStatus('Pronto', 'ready');
    e.target.value = '';
}

function updateProjectUI() {
    if (!currentProject) return;

    document.getElementById('projectInfo').style.display = 'block';
    document.getElementById('currentProjectName').textContent = currentProject.name;
    document.getElementById('currentTarget').textContent = `Target: ${currentProject.target || 'não definido'}`;
    document.getElementById('filesSection').style.display = 'block';
}

function enableButtons() {
    const buttons = [
        'btnSetTarget', 'btnBuild', 'btnQuickBuild', 'btnClean', 'btnFlash', 'btnMonitor',
        'btnSize', 'btnSizeComponents', 'btnSizeFiles',
        'btnMenuconfig', 'btnPartitions', 'btnReconfigure'
    ];

    buttons.forEach(id => {
        document.getElementById(id).disabled = false;
    });
}

// ============================================
// Build & Commands
// ============================================

async function buildProject() {
    if (!currentProject) return;

    const target = document.getElementById('targetSelect').value;
    updateStatus('Compilando...', 'building');
    clearTerminal();
    appendTerminal(`🔧 Iniciando build para ${target}...\n\n`, 'info');

    try {
        const response = await fetch(`${API_BASE}/api/project/${currentProject.id}/build`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target })
        });

        const data = await response.json();
        currentBuildId = data.buildId;

        // Poll for completion
        pollBuildStatus(data.buildId);

    } catch (err) {
        appendTerminal(`❌ Erro: ${err.message}\n`, 'error');
        updateStatus('Erro', 'error');
    }
}

async function pollBuildStatus(buildId) {
    const interval = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE}/api/build/${buildId}`);
            const build = await response.json();

            if (build.status === 'success') {
                clearInterval(interval);
                updateStatus('Build OK', 'success');
                updateFlashUI(build);
            } else if (build.status === 'failed') {
                clearInterval(interval);
                updateStatus('Build Falhou', 'error');
            }
        } catch (err) {
            // Continue polling
        }
    }, 2000);
}

async function cleanProject() {
    if (!currentProject) return;

    updateStatus('Limpando...', 'building');
    appendTerminal(`🧹 Limpando projeto...\n`, 'info');

    try {
        const response = await fetch(`${API_BASE}/api/project/${currentProject.id}/fullclean`, {
            method: 'POST'
        });
        await response.json();
    } catch (err) {
        appendTerminal(`❌ Erro: ${err.message}\n`, 'error');
    }
}

async function runCommand(command) {
    if (!currentProject) return;

    updateStatus(`Executando ${command}...`, 'building');
    switchTab('terminal');

    try {
        const response = await fetch(`${API_BASE}/api/project/${currentProject.id}/${command}`, {
            method: 'POST'
        });
        await response.json();
    } catch (err) {
        appendTerminal(`❌ Erro: ${err.message}\n`, 'error');
    }
}

// ============================================
// Target Selection
// ============================================

function showTargetModal() {
    document.getElementById('targetModal').style.display = 'flex';
}

function hideTargetModal() {
    document.getElementById('targetModal').style.display = 'none';
}

async function selectTarget(target) {
    if (!currentProject) return;

    updateStatus(`Configurando ${target}...`, 'building');
    appendTerminal(`🎯 Definindo target: ${target}\n`, 'info');

    try {
        const response = await fetch(`${API_BASE}/api/project/${currentProject.id}/set-target`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target })
        });

        await response.json();
        currentProject.target = target;
        document.getElementById('currentTarget').textContent = `Target: ${target}`;
        document.getElementById('targetSelect').value = target;

    } catch (err) {
        appendTerminal(`❌ Erro: ${err.message}\n`, 'error');
    }
}

// ============================================
// Flash UI
// ============================================

function updateFlashUI(build) {
    if (!build.binaries) return;

    // Update binaries grid
    const grid = document.getElementById('binariesGrid');
    grid.innerHTML = '';

    Object.entries(build.binaries).forEach(([name, url]) => {
        const item = document.createElement('div');
        item.className = 'binary-item';
        item.innerHTML = `
            <span class="binary-name">${name}</span>
            <a href="${url}" download class="btn btn-outline btn-sm">⬇️ Download</a>
        `;
        grid.appendChild(item);
    });

    // Setup ESP Web Tools
    if (build.manifestUrl) {
        const flashButtons = document.querySelectorAll('esp-web-install-button');
        flashButtons.forEach(btn => {
            btn.manifest = build.manifestUrl;
            btn.style.display = 'inline-block';
        });
    }
}

// ============================================
// File Tree
// ============================================

async function loadFileTree(subPath = '') {
    if (!currentProject) return;

    try {
        const response = await fetch(`${API_BASE}/api/project/${currentProject.id}/files?path=${encodeURIComponent(subPath)}`);
        const data = await response.json();

        const tree = document.getElementById('fileTree');
        if (subPath === '') tree.innerHTML = '';

        const container = subPath === '' ? tree : document.querySelector(`[data-path="${subPath}"]`);

        data.items
            .filter(item => !item.name.startsWith('.') && item.name !== 'build')
            .sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return b.isDirectory - a.isDirectory;
                return a.name.localeCompare(b.name);
            })
            .forEach(item => {
                const div = document.createElement('div');
                const fullPath = subPath ? `${subPath}/${item.name}` : item.name;

                div.className = `file-item ${item.isDirectory ? 'folder' : ''}`;
                div.innerHTML = `${item.isDirectory ? '📁' : '📄'} ${item.name}`;
                div.dataset.path = fullPath;

                if (item.isDirectory) {
                    div.addEventListener('click', () => loadFileTree(fullPath));
                } else {
                    div.addEventListener('click', () => openFile(fullPath));
                }

                container.appendChild(div);
            });

    } catch (err) {
        console.error('Error loading file tree:', err);
    }
}

// ============================================
// Monaco Editor
// ============================================

function initMonaco() {
    require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });

    require(['vs/editor/editor.main'], function () {
        monaco.editor.defineTheme('esp-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'editor.background': '#0d1117',
                'editorGutter.background': '#161b22',
                'editorLineNumber.foreground': '#6e7681',
            }
        });

        monacoEditor = monaco.editor.create(document.getElementById('monacoEditor'), {
            value: '// Abra um arquivo do projeto para editar',
            language: 'c',
            theme: 'esp-dark',
            fontSize: 13,
            fontFamily: 'JetBrains Mono, monospace',
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            automaticLayout: true,
        });

        monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);
    });
}

async function openFile(filePath) {
    if (!currentProject) return;

    try {
        const response = await fetch(`${API_BASE}/api/project/${currentProject.id}/file?path=${encodeURIComponent(filePath)}`);
        const data = await response.json();

        // Detect language
        const ext = filePath.split('.').pop().toLowerCase();
        const languageMap = {
            'c': 'c', 'h': 'c', 'cpp': 'cpp', 'hpp': 'cpp',
            'py': 'python', 'js': 'javascript', 'json': 'json',
            'cmake': 'cmake', 'txt': 'plaintext', 'md': 'markdown',
            'csv': 'plaintext', 'ini': 'ini', 'yaml': 'yaml', 'yml': 'yaml'
        };

        const language = languageMap[ext] || 'plaintext';

        // Update editor
        if (monacoEditor) {
            monacoEditor.setValue(data.content);
            monaco.editor.setModelLanguage(monacoEditor.getModel(), language);
        }

        // Store open file
        openFiles.set(filePath, data.content);

        // Update tabs
        updateEditorTabs(filePath);

        // Switch to editor tab
        switchTab('editor');

    } catch (err) {
        appendTerminal(`❌ Erro ao abrir arquivo: ${err.message}\n`, 'error');
    }
}

function updateEditorTabs(activePath) {
    const tabs = document.getElementById('editorTabs');
    tabs.innerHTML = '';

    openFiles.forEach((content, path) => {
        const fileName = path.split('/').pop();
        const tab = document.createElement('div');
        tab.className = `editor-tab ${path === activePath ? 'active' : ''}`;
        tab.innerHTML = `
            ${fileName}
            <span class="close" data-path="${path}">×</span>
        `;
        tab.addEventListener('click', (e) => {
            if (e.target.classList.contains('close')) {
                openFiles.delete(e.target.dataset.path);
                updateEditorTabs(activePath);
            } else {
                openFile(path);
            }
        });
        tabs.appendChild(tab);
    });
}

async function saveCurrentFile() {
    if (!currentProject || openFiles.size === 0) return;

    const activeTab = document.querySelector('.editor-tab.active');
    if (!activeTab) return;

    const filePath = Array.from(openFiles.keys()).find(p =>
        activeTab.textContent.includes(p.split('/').pop())
    );

    if (!filePath) return;

    try {
        await fetch(`${API_BASE}/api/project/${currentProject.id}/file`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: filePath,
                content: monacoEditor.getValue()
            })
        });

        appendTerminal(`💾 Arquivo salvo: ${filePath}\n`, 'success');
    } catch (err) {
        appendTerminal(`❌ Erro ao salvar: ${err.message}\n`, 'error');
    }
}

// ============================================
// Config (sdkconfig)
// ============================================

let configData = {};

async function loadConfig() {
    if (!currentProject) return;

    try {
        const response = await fetch(`${API_BASE}/api/project/${currentProject.id}/sdkconfig`);
        const data = await response.json();
        configData = data.configs;
        renderConfig(configData);
    } catch (err) {
        appendTerminal(`❌ Erro ao carregar config: ${err.message}\n`, 'error');
    }
}

function renderConfig(configs) {
    const list = document.getElementById('configList');
    list.innerHTML = '';

    Object.entries(configs).forEach(([key, value]) => {
        const item = document.createElement('div');
        item.className = 'config-item';
        item.dataset.key = key;

        let input;
        if (typeof value === 'boolean') {
            input = `<input type="checkbox" ${value ? 'checked' : ''}>`;
        } else if (typeof value === 'number') {
            input = `<input type="number" value="${value}">`;
        } else {
            input = `<input type="text" value="${value || ''}">`;
        }

        item.innerHTML = `
            <span class="config-key">${key}</span>
            <div class="config-value">${input}</div>
        `;

        list.appendChild(item);
    });
}

function filterConfig(e) {
    const search = e.target.value.toLowerCase();
    document.querySelectorAll('.config-item').forEach(item => {
        const key = item.dataset.key.toLowerCase();
        item.style.display = key.includes(search) ? 'flex' : 'none';
    });
}

async function saveConfig() {
    if (!currentProject) return;

    const configs = {};
    document.querySelectorAll('.config-item').forEach(item => {
        const key = item.dataset.key;
        const input = item.querySelector('input');

        if (input.type === 'checkbox') {
            configs[key] = input.checked;
        } else if (input.type === 'number') {
            configs[key] = parseInt(input.value);
        } else {
            configs[key] = input.value;
        }
    });

    try {
        await fetch(`${API_BASE}/api/project/${currentProject.id}/sdkconfig`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configs })
        });

        appendTerminal('💾 Configuração salva!\n', 'success');
    } catch (err) {
        appendTerminal(`❌ Erro ao salvar: ${err.message}\n`, 'error');
    }
}

// ============================================
// Partitions
// ============================================

let partitionsData = [];

async function loadPartitions() {
    if (!currentProject) return;

    try {
        const response = await fetch(`${API_BASE}/api/project/${currentProject.id}/partitions`);
        const data = await response.json();
        partitionsData = data.partitions;
        renderPartitions(partitionsData);
    } catch (err) {
        appendTerminal(`❌ Erro ao carregar partições: ${err.message}\n`, 'error');
    }
}

function renderPartitions(partitions) {
    // Visual representation
    const visual = document.getElementById('partitionsVisual');
    visual.innerHTML = '';

    const totalSize = partitions.reduce((sum, p) => sum + parseSize(p.size), 0);

    partitions.forEach(p => {
        const block = document.createElement('div');
        const size = parseSize(p.size);
        const percent = (size / totalSize) * 100;

        block.className = `partition-block type-${p.subtype || p.type}`;
        block.style.width = `${Math.max(percent, 5)}%`;
        block.title = `${p.name}: ${p.size}`;
        block.textContent = p.name;

        visual.appendChild(block);
    });

    // Table
    const tbody = document.getElementById('partitionsBody');
    tbody.innerHTML = '';

    partitions.forEach((p, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><input type="text" value="${p.name}" data-field="name"></td>
            <td>
                <select data-field="type">
                    <option value="app" ${p.type === 'app' ? 'selected' : ''}>app</option>
                    <option value="data" ${p.type === 'data' ? 'selected' : ''}>data</option>
                </select>
            </td>
            <td>
                <select data-field="subtype">
                    <option value="factory" ${p.subtype === 'factory' ? 'selected' : ''}>factory</option>
                    <option value="ota_0" ${p.subtype === 'ota_0' ? 'selected' : ''}>ota_0</option>
                    <option value="ota_1" ${p.subtype === 'ota_1' ? 'selected' : ''}>ota_1</option>
                    <option value="nvs" ${p.subtype === 'nvs' ? 'selected' : ''}>nvs</option>
                    <option value="phy" ${p.subtype === 'phy' ? 'selected' : ''}>phy</option>
                    <option value="spiffs" ${p.subtype === 'spiffs' ? 'selected' : ''}>spiffs</option>
                    <option value="fat" ${p.subtype === 'fat' ? 'selected' : ''}>fat</option>
                </select>
            </td>
            <td><input type="text" value="${p.offset}" data-field="offset"></td>
            <td><input type="text" value="${p.size}" data-field="size"></td>
            <td>
                <button class="btn btn-icon" onclick="removePartition(${index})">🗑️</button>
            </td>
        `;
        row.dataset.index = index;
        tbody.appendChild(row);
    });
}

function parseSize(size) {
    if (typeof size === 'number') return size;
    if (size.startsWith('0x')) return parseInt(size, 16);
    const match = size.match(/(\d+)(K|M)?/i);
    if (!match) return 0;
    const num = parseInt(match[1]);
    if (match[2]?.toUpperCase() === 'K') return num * 1024;
    if (match[2]?.toUpperCase() === 'M') return num * 1024 * 1024;
    return num;
}

function addPartition() {
    partitionsData.push({
        name: 'new_partition',
        type: 'data',
        subtype: 'spiffs',
        offset: '',
        size: '0x10000'
    });
    renderPartitions(partitionsData);
}

window.removePartition = function (index) {
    partitionsData.splice(index, 1);
    renderPartitions(partitionsData);
};

async function savePartitions() {
    if (!currentProject) return;

    // Collect data from table
    const partitions = [];
    document.querySelectorAll('#partitionsBody tr').forEach(row => {
        partitions.push({
            name: row.querySelector('[data-field="name"]').value,
            type: row.querySelector('[data-field="type"]').value,
            subtype: row.querySelector('[data-field="subtype"]').value,
            offset: row.querySelector('[data-field="offset"]').value,
            size: row.querySelector('[data-field="size"]').value
        });
    });

    try {
        await fetch(`${API_BASE}/api/project/${currentProject.id}/partitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ partitions })
        });

        appendTerminal('💾 Partições salvas!\n', 'success');
    } catch (err) {
        appendTerminal(`❌ Erro ao salvar: ${err.message}\n`, 'error');
    }
}

// ============================================
// Serial Monitor
// ============================================

async function toggleSerial() {
    const btn = document.getElementById('connectSerial');

    if (serialPort) {
        await disconnectSerial();
        btn.textContent = '🔌 Conectar';
    } else {
        await connectSerial();
        btn.textContent = '🔌 Desconectar';
    }
}

async function connectSerial() {
    if (!('serial' in navigator)) {
        appendMonitor('❌ Web Serial API não suportada neste navegador!\n');
        return;
    }

    try {
        serialPort = await navigator.serial.requestPort();
        const baudRate = parseInt(document.getElementById('baudRate').value);

        await serialPort.open({ baudRate });

        document.getElementById('serialInput').disabled = false;
        document.getElementById('sendSerial').disabled = false;
        document.getElementById('connectionStatus').innerHTML = '<span class="dot online"></span><span>Conectado</span>';

        appendMonitor(`✅ Conectado! Baud rate: ${baudRate}\n`);

        // Start reading
        readSerial();

    } catch (err) {
        if (err.name !== 'NotFoundError') {
            appendMonitor(`❌ Erro ao conectar: ${err.message}\n`);
        }
    }
}

async function readSerial() {
    const decoder = new TextDecoder();

    while (serialPort?.readable) {
        serialReader = serialPort.readable.getReader();

        try {
            while (true) {
                const { value, done } = await serialReader.read();
                if (done) break;

                let text = decoder.decode(value);

                if (document.getElementById('showTimestamp').checked) {
                    const now = new Date().toLocaleTimeString();
                    text = `[${now}] ${text}`;
                }

                appendMonitor(text);
            }
        } catch (err) {
            // Port closed or error
        } finally {
            serialReader.releaseLock();
        }
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

    document.getElementById('serialInput').disabled = true;
    document.getElementById('sendSerial').disabled = true;
    document.getElementById('connectionStatus').innerHTML = '<span class="dot offline"></span><span>Desconectado</span>';

    appendMonitor('\n🔌 Desconectado\n');
}

async function sendSerialData() {
    if (!serialPort?.writable) return;

    const input = document.getElementById('serialInput');
    const text = input.value + '\n';

    const encoder = new TextEncoder();
    const writer = serialPort.writable.getWriter();

    try {
        await writer.write(encoder.encode(text));
        appendMonitor(`> ${input.value}\n`);
        input.value = '';
    } catch (err) {
        appendMonitor(`❌ Erro ao enviar: ${err.message}\n`);
    } finally {
        writer.releaseLock();
    }
}

function appendMonitor(text) {
    const output = document.getElementById('monitorOutput');
    output.textContent += text;

    if (document.getElementById('autoScroll').checked) {
        const body = document.getElementById('monitorBody');
        body.scrollTop = body.scrollHeight;
    }
}

function clearMonitor() {
    document.getElementById('monitorOutput').textContent = '';
}

function downloadLogs() {
    const content = document.getElementById('monitorOutput').textContent;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `esp32-logs-${Date.now()}.txt`;
    a.click();

    URL.revokeObjectURL(url);
}

// ============================================
// Terminal Helpers
// ============================================

function appendTerminal(text, type = 'info') {
    const terminal = document.getElementById('terminalOutput');
    const span = document.createElement('span');
    span.className = `line-${type}`;
    span.textContent = text;
    terminal.appendChild(span);

    const body = document.getElementById('terminalBody');
    body.scrollTop = body.scrollHeight;
}

function clearTerminal() {
    document.getElementById('terminalOutput').textContent = '';
}

// ============================================
// Projects List
// ============================================

async function loadProjects() {
    try {
        const response = await fetch(`${API_BASE}/api/projects`);
        const projects = await response.json();

        if (projects.length > 0) {
            currentProject = projects[projects.length - 1];
            updateProjectUI();
            enableButtons();
            loadFileTree();
        }
    } catch (err) {
        // No projects yet
    }
}
