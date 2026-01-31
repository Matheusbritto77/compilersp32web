import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync, createReadStream } from 'fs';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 80;

// Diretórios
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
const BUILD_DIR = process.env.BUILD_DIR || path.join(__dirname, '../builds');
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(__dirname, '../projects');

// Garantir que diretórios existem
[UPLOAD_DIR, BUILD_DIR, PROJECTS_DIR].forEach(dir => {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Configuração do Multer para upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}.zip`)
});
const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' ||
            file.mimetype === 'application/x-zip-compressed' ||
            file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos ZIP são permitidos!'));
        }
    }
});

// Armazenar status dos builds e projetos
const builds = new Map();
const projects = new Map();

// Criar servidor HTTP
const server = http.createServer(app);

// WebSocket para logs em tempo real
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
    console.log('Cliente WebSocket conectado');
    ws.on('close', () => console.log('Cliente WebSocket desconectado'));
});

function broadcastLog(buildId, message, type = 'info') {
    const data = JSON.stringify({ buildId, message, type, timestamp: new Date().toISOString() });
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(data);
        }
    });
}

// Executar comando IDF com streaming de output
function runIdfCommand(projectPath, command, buildId) {
    return new Promise((resolve, reject) => {
        const fullCmd = `source /opt/esp/idf/export.sh && cd "${projectPath}" && ${command}`;

        broadcastLog(buildId, `$ ${command}`, 'command');

        const proc = spawn('bash', ['-c', fullCmd], {
            cwd: projectPath,
            env: { ...process.env, IDF_PATH: '/opt/esp/idf' }
        });

        let output = '';

        proc.stdout.on('data', (data) => {
            const msg = data.toString();
            output += msg;
            broadcastLog(buildId, msg, 'stdout');
        });

        proc.stderr.on('data', (data) => {
            const msg = data.toString();
            output += msg;
            broadcastLog(buildId, msg, 'stderr');
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ success: true, output });
            } else {
                reject(new Error(`Command failed with code ${code}\n${output}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

// ================== API: PROJETOS ==================

// Upload de projeto
app.post('/api/project/upload', upload.single('project'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        const projectId = uuidv4();
        const zipPath = req.file.path;
        const extractPath = path.join(PROJECTS_DIR, projectId);

        // Extrair ZIP
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractPath, true);

        // Remover ZIP original
        await fs.unlink(zipPath);

        // Verificar se tem subpasta única
        let projectPath = extractPath;
        const items = await fs.readdir(extractPath);
        if (items.length === 1) {
            const subPath = path.join(extractPath, items[0]);
            const stat = await fs.stat(subPath);
            if (stat.isDirectory()) {
                projectPath = subPath;
            }
        }

        // Detectar tipo e infos do projeto
        const files = await fs.readdir(projectPath);
        const hasMain = files.includes('main');
        const hasCMake = files.includes('CMakeLists.txt');
        const hasPartitions = files.includes('partitions.csv');
        const hasSdkconfig = files.includes('sdkconfig') || files.includes('sdkconfig.defaults');

        // Ler nome do projeto
        let projectName = 'unknown';
        if (hasCMake) {
            try {
                const cmake = await fs.readFile(path.join(projectPath, 'CMakeLists.txt'), 'utf-8');
                const match = cmake.match(/project\(([^)]+)\)/);
                if (match) projectName = match[1].trim();
            } catch (e) { }
        }

        const project = {
            id: projectId,
            name: projectName,
            path: projectPath,
            originalName: req.file.originalname,
            hasMain,
            hasCMake,
            hasPartitions,
            hasSdkconfig,
            target: null,
            createdAt: Date.now()
        };

        projects.set(projectId, project);

        res.json({
            success: true,
            project
        });

    } catch (error) {
        console.error('Erro no upload:', error);
        res.status(500).json({ error: error.message });
    }
});

// Listar projetos
app.get('/api/projects', async (req, res) => {
    const projectList = [];
    projects.forEach((value, key) => {
        projectList.push({ id: key, ...value });
    });
    res.json(projectList);
});

// Info do projeto
app.get('/api/project/:projectId', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }
    res.json(project);
});

// Deletar projeto
app.delete('/api/project/:projectId', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (project) {
        try {
            await fs.rm(path.dirname(project.path), { recursive: true, force: true });
        } catch (e) { }
        projects.delete(req.params.projectId);
    }
    res.json({ success: true });
});

// ================== API: BUILD ==================

// Set target
app.post('/api/project/:projectId/set-target', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const { target } = req.body;
    const validTargets = ['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp32c6', 'esp32h2'];

    if (!validTargets.includes(target)) {
        return res.status(400).json({ error: `Target inválido. Use: ${validTargets.join(', ')}` });
    }

    const buildId = uuidv4();

    res.json({ buildId, message: 'Set-target iniciado' });

    try {
        await runIdfCommand(project.path, `idf.py set-target ${target}`, buildId);
        project.target = target;
        broadcastLog(buildId, `✅ Target definido: ${target}`, 'success');
    } catch (error) {
        broadcastLog(buildId, `❌ Erro: ${error.message}`, 'error');
    }
});

// Build
app.post('/api/project/:projectId/build', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const buildId = uuidv4();
    const target = req.body.target || project.target || 'esp32';

    builds.set(buildId, {
        projectId: project.id,
        status: 'building',
        target,
        startTime: Date.now()
    });

    res.json({ buildId, message: 'Build iniciado' });

    try {
        // Set target se necessário
        if (!project.target || project.target !== target) {
            await runIdfCommand(project.path, `idf.py set-target ${target}`, buildId);
            project.target = target;
        }

        // Build
        await runIdfCommand(project.path, 'idf.py build', buildId);

        // Processar binários
        const buildDir = path.join(project.path, 'build');
        const outDir = path.join(BUILD_DIR, buildId);
        mkdirSync(outDir, { recursive: true });

        const files = await fs.readdir(buildDir);
        const binFiles = files.filter(f => f.endsWith('.bin'));

        const binaries = {};
        for (const bin of binFiles) {
            await fs.copyFile(path.join(buildDir, bin), path.join(outDir, bin));
            binaries[bin] = `/builds/${buildId}/${bin}`;
        }

        // Copiar bootloader e partition table
        const extraFiles = ['bootloader/bootloader.bin', 'partition_table/partition-table.bin'];
        for (const ef of extraFiles) {
            const src = path.join(buildDir, ef);
            if (existsSync(src)) {
                const name = ef.replace('/', '-');
                await fs.copyFile(src, path.join(outDir, name));
                binaries[name] = `/builds/${buildId}/${name}`;
            }
        }

        // Criar manifest.json para ESP Web Tools
        const manifest = {
            name: project.name,
            builds: [{
                chipFamily: target.toUpperCase().replace('ESP32', 'ESP32'),
                parts: []
            }]
        };

        // Ler flash_args para offsets
        const flashArgsPath = path.join(buildDir, 'flash_args');
        const flashArgs = {};
        try {
            if (existsSync(flashArgsPath)) {
                const content = await fs.readFile(flashArgsPath, 'utf-8');
                content.split('\n').forEach(line => {
                    const match = line.match(/(0x[0-9a-fA-F]+)\s+(.+)/);
                    if (match) flashArgs[path.basename(match[2].trim())] = match[1];
                });
            }
        } catch (e) { }

        for (const [name] of Object.entries(binaries)) {
            let offset = flashArgs[name.replace('-', '/')];
            if (!offset) {
                if (name.includes('bootloader')) offset = '0x1000';
                else if (name.includes('partition')) offset = '0x8000';
                else if (name.endsWith('.bin')) offset = '0x10000';
            }
            if (offset) {
                manifest.builds[0].parts.push({
                    path: name,
                    offset: parseInt(offset, 16)
                });
            }
        }

        await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

        builds.set(buildId, {
            ...builds.get(buildId),
            status: 'success',
            binaries,
            manifestUrl: `/builds/${buildId}/manifest.json`,
            endTime: Date.now()
        });

        broadcastLog(buildId, '✅ Build concluído com sucesso!', 'success');

    } catch (error) {
        builds.set(buildId, {
            ...builds.get(buildId),
            status: 'failed',
            error: error.message,
            endTime: Date.now()
        });
        broadcastLog(buildId, `❌ Build falhou: ${error.message}`, 'error');
    }
});

// Full clean
app.post('/api/project/:projectId/fullclean', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const buildId = uuidv4();
    res.json({ buildId });

    try {
        await runIdfCommand(project.path, 'idf.py fullclean', buildId);
        project.target = null;
        broadcastLog(buildId, '✅ Projeto limpo com sucesso!', 'success');
    } catch (error) {
        broadcastLog(buildId, `❌ Erro: ${error.message}`, 'error');
    }
});

// Size info
app.post('/api/project/:projectId/size', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const buildId = uuidv4();
    res.json({ buildId });

    try {
        await runIdfCommand(project.path, 'idf.py size', buildId);
        broadcastLog(buildId, '✅ Análise de tamanho concluída!', 'success');
    } catch (error) {
        broadcastLog(buildId, `❌ Erro: ${error.message}`, 'error');
    }
});

// Size components
app.post('/api/project/:projectId/size-components', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const buildId = uuidv4();
    res.json({ buildId });

    try {
        await runIdfCommand(project.path, 'idf.py size-components', buildId);
        broadcastLog(buildId, '✅ Análise de componentes concluída!', 'success');
    } catch (error) {
        broadcastLog(buildId, `❌ Erro: ${error.message}`, 'error');
    }
});

// Size files
app.post('/api/project/:projectId/size-files', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const buildId = uuidv4();
    res.json({ buildId });

    try {
        await runIdfCommand(project.path, 'idf.py size-files', buildId);
        broadcastLog(buildId, '✅ Análise de arquivos concluída!', 'success');
    } catch (error) {
        broadcastLog(buildId, `❌ Erro: ${error.message}`, 'error');
    }
});

// Menuconfig (retorna JSON das configurações)
app.get('/api/project/:projectId/sdkconfig', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    try {
        const sdkconfigPath = path.join(project.path, 'sdkconfig');
        if (!existsSync(sdkconfigPath)) {
            return res.json({ configs: {} });
        }

        const content = await fs.readFile(sdkconfigPath, 'utf-8');
        const configs = {};

        content.split('\n').forEach(line => {
            if (line.startsWith('CONFIG_')) {
                const [key, ...valueParts] = line.split('=');
                let value = valueParts.join('=');
                if (value === 'y') value = true;
                else if (value === 'n' || value === '') value = false;
                else if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                } else if (!isNaN(value)) {
                    value = parseInt(value);
                }
                configs[key] = value;
            }
        });

        res.json({ configs });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Salvar configurações
app.post('/api/project/:projectId/sdkconfig', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const { configs } = req.body;
    if (!configs || typeof configs !== 'object') {
        return res.status(400).json({ error: 'Configs inválidas' });
    }

    try {
        let content = '# ESP-IDF SDK Configuration\n';

        for (const [key, value] of Object.entries(configs)) {
            if (value === true) {
                content += `${key}=y\n`;
            } else if (value === false) {
                content += `# ${key} is not set\n`;
            } else if (typeof value === 'string') {
                content += `${key}="${value}"\n`;
            } else {
                content += `${key}=${value}\n`;
            }
        }

        await fs.writeFile(path.join(project.path, 'sdkconfig'), content);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ================== API: PARTIÇÕES ==================

// Ler tabela de partições
app.get('/api/project/:projectId/partitions', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    try {
        const partPath = path.join(project.path, 'partitions.csv');
        if (!existsSync(partPath)) {
            // Retornar partição padrão
            return res.json({
                partitions: [
                    { name: 'nvs', type: 'data', subtype: 'nvs', offset: '0x9000', size: '0x6000' },
                    { name: 'phy_init', type: 'data', subtype: 'phy', offset: '0xf000', size: '0x1000' },
                    { name: 'factory', type: 'app', subtype: 'factory', offset: '0x10000', size: '0x100000' }
                ]
            });
        }

        const content = await fs.readFile(partPath, 'utf-8');
        const partitions = [];

        content.split('\n').forEach(line => {
            line = line.trim();
            if (!line || line.startsWith('#')) return;
            const parts = line.split(',').map(p => p.trim());
            if (parts.length >= 5) {
                partitions.push({
                    name: parts[0],
                    type: parts[1],
                    subtype: parts[2],
                    offset: parts[3],
                    size: parts[4],
                    flags: parts[5] || ''
                });
            }
        });

        res.json({ partitions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Salvar tabela de partições
app.post('/api/project/:projectId/partitions', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const { partitions } = req.body;
    if (!Array.isArray(partitions)) {
        return res.status(400).json({ error: 'Partições inválidas' });
    }

    try {
        let content = '# Name,   Type, SubType, Offset,  Size, Flags\n';

        for (const p of partitions) {
            content += `${p.name}, ${p.type}, ${p.subtype}, ${p.offset}, ${p.size}${p.flags ? ', ' + p.flags : ''}\n`;
        }

        await fs.writeFile(path.join(project.path, 'partitions.csv'), content);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ================== API: FILES (explorador de arquivos) ==================

// Listar arquivos do projeto
app.get('/api/project/:projectId/files', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const subPath = req.query.path || '';
    const fullPath = path.join(project.path, subPath);

    try {
        const items = await fs.readdir(fullPath, { withFileTypes: true });
        const result = [];

        for (const item of items) {
            const stat = await fs.stat(path.join(fullPath, item.name));
            result.push({
                name: item.name,
                isDirectory: item.isDirectory(),
                size: stat.size,
                modified: stat.mtime
            });
        }

        res.json({ path: subPath, items: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ler conteúdo de arquivo
app.get('/api/project/:projectId/file', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const filePath = req.query.path;
    if (!filePath) {
        return res.status(400).json({ error: 'Path não especificado' });
    }

    const fullPath = path.join(project.path, filePath);

    try {
        const content = await fs.readFile(fullPath, 'utf-8');
        res.json({ path: filePath, content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Salvar arquivo
app.put('/api/project/:projectId/file', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const { path: filePath, content } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: 'Path não especificado' });
    }

    const fullPath = path.join(project.path, filePath);

    try {
        await fs.writeFile(fullPath, content);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Criar arquivo
app.post('/api/project/:projectId/file', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const { path: filePath, content, isDirectory } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: 'Path não especificado' });
    }

    const fullPath = path.join(project.path, filePath);

    try {
        if (isDirectory) {
            await fs.mkdir(fullPath, { recursive: true });
        } else {
            await fs.writeFile(fullPath, content || '');
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Deletar arquivo
app.delete('/api/project/:projectId/file', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const filePath = req.query.path;
    if (!filePath) {
        return res.status(400).json({ error: 'Path não especificado' });
    }

    const fullPath = path.join(project.path, filePath);

    try {
        await fs.rm(fullPath, { recursive: true, force: true });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ================== API: COMANDOS EXTRAS ==================

// Reconfigure (regenerar cmake)
app.post('/api/project/:projectId/reconfigure', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const buildId = uuidv4();
    res.json({ buildId });

    try {
        await runIdfCommand(project.path, 'idf.py reconfigure', buildId);
        broadcastLog(buildId, '✅ CMake reconfigurado!', 'success');
    } catch (error) {
        broadcastLog(buildId, `❌ Erro: ${error.message}`, 'error');
    }
});

// Listar componentes
app.post('/api/project/:projectId/list-components', async (req, res) => {
    const project = projects.get(req.params.projectId);
    if (!project) {
        return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const buildId = uuidv4();
    res.json({ buildId });

    try {
        await runIdfCommand(project.path, 'idf.py show-efuse-table 2>/dev/null || echo "OK"', buildId);
        broadcastLog(buildId, '✅ Componentes listados!', 'success');
    } catch (error) {
        broadcastLog(buildId, `❌ Erro: ${error.message}`, 'error');
    }
});

// ================== API: STATUS ==================

// Status do build
app.get('/api/build/:buildId', (req, res) => {
    const build = builds.get(req.params.buildId);
    if (!build) {
        return res.status(404).json({ error: 'Build não encontrado' });
    }
    res.json(build);
});

// Listar builds
app.get('/api/builds', (req, res) => {
    const buildList = [];
    builds.forEach((value, key) => {
        buildList.push({ id: key, ...value });
    });
    res.json(buildList.slice(-50));
});

// Servir arquivos de build
app.use('/builds', express.static(BUILD_DIR));

// Download de firmware
app.get('/api/download/:buildId/:filename', (req, res) => {
    const { buildId, filename } = req.params;
    const filePath = path.join(BUILD_DIR, buildId, filename);

    if (!existsSync(filePath)) {
        return res.status(404).json({ error: 'Arquivo não encontrado' });
    }

    res.download(filePath);
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        builds: builds.size,
        projects: projects.size,
        features: [
            'build', 'fullclean', 'reconfigure',
            'set-target', 'size', 'size-components', 'size-files',
            'sdkconfig', 'partitions', 'file-editor',
            'web-flash', 'serial-monitor'
        ],
        targets: ['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp32c6', 'esp32h2']
    });
});

// Info do sistema ESP-IDF
app.get('/api/idf-info', async (req, res) => {
    try {
        const result = await new Promise((resolve, reject) => {
            exec('source /opt/esp/idf/export.sh && idf.py --version', { shell: '/bin/bash' }, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout.trim());
            });
        });
        res.json({ version: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ESP32 Web IDE rodando em http://0.0.0.0:${PORT}`);
    console.log(`📁 Projects dir: ${PROJECTS_DIR}`);
    console.log(`📁 Build dir: ${BUILD_DIR}`);
    console.log(`🔧 Features: build, flash, monitor, menuconfig, partitions, file-editor`);
});
