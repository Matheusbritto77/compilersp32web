import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Diretórios
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
const BUILD_DIR = process.env.BUILD_DIR || path.join(__dirname, '../builds');

// Garantir que diretórios existem
[UPLOAD_DIR, BUILD_DIR].forEach(dir => {
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
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
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

// Armazenar status dos builds
const builds = new Map();

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

// Detectar tipo de projeto
async function detectProjectType(projectPath) {
    const files = await fs.readdir(projectPath);
    
    // ESP-IDF project
    if (files.includes('CMakeLists.txt') && files.includes('main')) {
        return 'esp-idf';
    }
    
    // PlatformIO project
    if (files.includes('platformio.ini')) {
        return 'platformio';
    }
    
    // Arduino project (sketch)
    if (files.some(f => f.endsWith('.ino'))) {
        return 'arduino';
    }
    
    // Verificar se tem CMakeLists.txt com idf
    if (files.includes('CMakeLists.txt')) {
        try {
            const cmake = await fs.readFile(path.join(projectPath, 'CMakeLists.txt'), 'utf-8');
            if (cmake.includes('idf_component_register') || cmake.includes('project(')) {
                return 'esp-idf';
            }
        } catch (e) {}
    }
    
    return 'unknown';
}

// Compilar projeto ESP-IDF
async function buildEspIdf(buildId, projectPath, target = 'esp32') {
    return new Promise((resolve, reject) => {
        const buildPath = path.join(BUILD_DIR, buildId);
        
        broadcastLog(buildId, `🔧 Iniciando build ESP-IDF para ${target}...`, 'info');
        broadcastLog(buildId, `📁 Projeto: ${projectPath}`, 'info');
        
        // Comando de build ESP-IDF
        const buildCmd = `source /opt/esp/idf/export.sh && cd "${projectPath}" && idf.py set-target ${target} && idf.py build`;
        
        const proc = spawn('bash', ['-c', buildCmd], {
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
            // ESP-IDF usa stderr para muitas mensagens normais
            broadcastLog(buildId, msg, 'stderr');
        });

        proc.on('close', async (code) => {
            if (code === 0) {
                broadcastLog(buildId, '✅ Build concluído com sucesso!', 'success');
                
                // Encontrar binários gerados
                const buildDir = path.join(projectPath, 'build');
                try {
                    const files = await fs.readdir(buildDir);
                    const binFiles = files.filter(f => f.endsWith('.bin'));
                    
                    // Copiar binários para diretório de builds
                    if (!existsSync(buildPath)) {
                        mkdirSync(buildPath, { recursive: true });
                    }
                    
                    const binaries = {};
                    for (const bin of binFiles) {
                        const src = path.join(buildDir, bin);
                        const dest = path.join(buildPath, bin);
                        await fs.copyFile(src, dest);
                        binaries[bin] = `/builds/${buildId}/${bin}`;
                    }
                    
                    // Copiar também arquivos importantes para flash
                    const flashFiles = ['bootloader/bootloader.bin', 'partition_table/partition-table.bin'];
                    for (const ff of flashFiles) {
                        const src = path.join(buildDir, ff);
                        if (existsSync(src)) {
                            const destName = ff.replace('/', '-');
                            const dest = path.join(buildPath, destName);
                            await fs.copyFile(src, dest);
                            binaries[destName] = `/builds/${buildId}/${destName}`;
                        }
                    }
                    
                    // Ler flash_args se existir
                    const flashArgsPath = path.join(buildDir, 'flash_args');
                    let flashArgs = null;
                    if (existsSync(flashArgsPath)) {
                        flashArgs = await fs.readFile(flashArgsPath, 'utf-8');
                    }
                    
                    resolve({ success: true, binaries, flashArgs, output });
                } catch (e) {
                    reject(new Error(`Erro ao processar binários: ${e.message}`));
                }
            } else {
                broadcastLog(buildId, `❌ Build falhou com código ${code}`, 'error');
                reject(new Error(`Build falhou com código ${code}\n${output}`));
            }
        });

        proc.on('error', (err) => {
            broadcastLog(buildId, `❌ Erro: ${err.message}`, 'error');
            reject(err);
        });
    });
}

// API Routes

// Upload e iniciar build
app.post('/api/upload', upload.single('project'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        const buildId = uuidv4();
        const zipPath = req.file.path;
        const extractPath = path.join(UPLOAD_DIR, buildId);
        const target = req.body.target || 'esp32';

        broadcastLog(buildId, `📦 Arquivo recebido: ${req.file.originalname}`, 'info');

        // Extrair ZIP
        broadcastLog(buildId, '📂 Extraindo projeto...', 'info');
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractPath, true);

        // Remover ZIP original
        await fs.unlink(zipPath);

        // Verificar se tem subpasta única (comum em ZIPs do GitHub)
        let projectPath = extractPath;
        const items = await fs.readdir(extractPath);
        if (items.length === 1) {
            const subPath = path.join(extractPath, items[0]);
            const stat = await fs.stat(subPath);
            if (stat.isDirectory()) {
                projectPath = subPath;
            }
        }

        // Detectar tipo de projeto
        const projectType = await detectProjectType(projectPath);
        broadcastLog(buildId, `🔍 Tipo de projeto detectado: ${projectType}`, 'info');

        if (projectType === 'unknown') {
            return res.status(400).json({ 
                error: 'Tipo de projeto não reconhecido. Certifique-se de que é um projeto ESP-IDF válido.',
                buildId 
            });
        }

        // Iniciar build
        builds.set(buildId, { 
            status: 'building', 
            projectType, 
            target,
            startTime: Date.now(),
            projectPath 
        });

        res.json({ 
            buildId, 
            projectType,
            target,
            message: 'Build iniciado! Acompanhe o progresso via WebSocket.' 
        });

        // Build assíncrono
        try {
            const result = await buildEspIdf(buildId, projectPath, target);
            builds.set(buildId, { 
                ...builds.get(buildId), 
                status: 'success', 
                ...result,
                endTime: Date.now()
            });
        } catch (error) {
            builds.set(buildId, { 
                ...builds.get(buildId), 
                status: 'failed', 
                error: error.message,
                endTime: Date.now()
            });
        }

    } catch (error) {
        console.error('Erro no upload:', error);
        res.status(500).json({ error: error.message });
    }
});

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
    res.json(buildList.slice(-20)); // Últimos 20
});

// Servir arquivos de build
app.use('/builds', express.static(BUILD_DIR));

// Download de firmware específico
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
        builds: builds.size 
    });
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ESP32 Web Flasher rodando em http://0.0.0.0:${PORT}`);
    console.log(`📁 Upload dir: ${UPLOAD_DIR}`);
    console.log(`📁 Build dir: ${BUILD_DIR}`);
});
