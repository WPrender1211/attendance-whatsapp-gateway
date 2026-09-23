const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'attendance_wa_secret_key_2026';
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');

app.use(cors());
app.use(express.json());

let sock = null;
let qrCodeRaw = null;
let qrCodeDataUrl = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let connectedUser = null;
let mongoDb = null;
let syncTimeout = null;

// Ensure auth folder exists
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

// ---------------- MongoDB Session Persistence ----------------
async function initMongo() {
    if (!MONGO_URI) {
        console.log('ℹ️ No MONGO_URI provided. Running session in local file storage mode.');
        return;
    }
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        mongoDb = client.db('attendance_wa');
        console.log('🍃 MongoDB Atlas Connected! Cloud session sync active.');
    } catch (err) {
        console.error('⚠️ MongoDB Connection failed, falling back to local files:', err.message);
    }
}

async function restoreAuthFromMongo() {
    if (!mongoDb) return;
    try {
        const collection = mongoDb.collection('wa_auth_files');
        const docs = await collection.find({}).toArray();
        if (docs.length > 0) {
            console.log(`📥 Restoring ${docs.length} session auth file(s) from MongoDB...`);
            for (const doc of docs) {
                const filePath = path.join(AUTH_FOLDER, doc._id);
                fs.writeFileSync(filePath, Buffer.from(doc.data, 'base64'));
            }
            console.log('✅ Session restored from MongoDB Atlas successfully.');
        }
    } catch (err) {
        console.error('Error restoring session from MongoDB:', err.message);
    }
}

async function saveAuthToMongo() {
    if (!mongoDb) return;
    try {
        if (!fs.existsSync(AUTH_FOLDER)) return;
        const files = fs.readdirSync(AUTH_FOLDER);
        if (files.length === 0) return;

        const collection = mongoDb.collection('wa_auth_files');
        const operations = [];

        for (const file of files) {
            const filePath = path.join(AUTH_FOLDER, file);
            if (fs.statSync(filePath).isFile()) {
                const content = fs.readFileSync(filePath).toString('base64');
                operations.push({
                    replaceOne: {
                        filter: { _id: file },
                        replacement: { _id: file, data: content, updatedAt: new Date() },
                        upsert: true
                    }
                });
            }
        }

        if (operations.length > 0) {
            await collection.bulkWrite(operations);
        }
    } catch (err) {
        console.error('Error saving session to MongoDB:', err.message);
    }
}

function queueSaveAuthToMongo() {
    if (!mongoDb) return;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        saveAuthToMongo();
    }, 1500);
}

async function clearAuthFromMongo() {
    if (!mongoDb) return;
    try {
        const collection = mongoDb.collection('wa_auth_files');
        await collection.deleteMany({});
        console.log('🗑️ MongoDB session data cleared.');
    } catch (err) {
        console.error('Error clearing MongoDB session:', err.message);
    }
}

// Middleware to check API key for protected routes
function requireAuth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
    if (API_KEY && key !== API_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized. Invalid or missing API Key.' });
    }
    next();
}

async function connectToWhatsApp() {
    connectionStatus = 'connecting';
    await restoreAuthFromMongo();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Attendance Notification System', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        queueSaveAuthToMongo();
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeRaw = qr;
            try {
                qrCodeDataUrl = await qrcode.toDataURL(qr);
            } catch (err) {
                console.error('Error generating QR Data URL:', err);
            }
            connectionStatus = 'qr_ready';
            console.log('⚡ New WhatsApp QR Code generated.');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Connection closed (Status: ${statusCode}). Reconnect: ${shouldReconnect}`);
            
            connectionStatus = 'disconnected';
            qrCodeRaw = null;
            qrCodeDataUrl = null;
            connectedUser = null;

            if (statusCode === DisconnectReason.loggedOut) {
                // Clear session files and MongoDB if logged out
                try {
                    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                } catch (e) {}
                await clearAuthFromMongo();
            }

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connection opened successfully!');
            connectionStatus = 'connected';
            qrCodeRaw = null;
            qrCodeDataUrl = null;
            connectedUser = sock.user || null;
            queueSaveAuthToMongo();
        }
    });
}

// 1. Health check / Root
app.get('/', (req, res) => {
    res.json({
        success: true,
        service: 'Attendance WhatsApp Gateway',
        status: connectionStatus,
        mongo_backup: !!mongoDb,
        user: connectedUser ? { id: connectedUser.id, name: connectedUser.name } : null
    });
});

// 2. Status check
app.get('/status', (req, res) => {
    res.json({
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        mongo_backup: !!mongoDb,
        user: connectedUser ? { id: connectedUser.id, name: connectedUser.name } : null,
        has_qr: !!qrCodeDataUrl
    });
});

// 3. Get QR Code (JSON with Base64 image data)
app.get('/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({
            success: true,
            status: 'connected',
            message: 'WhatsApp is already connected.',
            qr_image: null,
            user: connectedUser
        });
    }

    if (!qrCodeDataUrl) {
        return res.json({
            success: false,
            status: connectionStatus,
            message: 'QR code not ready yet. Please wait a few seconds and refresh.',
            qr_image: null
        });
    }

    res.json({
        success: true,
        status: 'qr_ready',
        qr_image: qrCodeDataUrl,
        raw_qr: qrCodeRaw
    });
});

// 4. Direct QR Image Output (Render as PNG)
app.get('/qr-image', async (req, res) => {
    if (!qrCodeRaw) {
        return res.status(404).send('QR code not available or WhatsApp is already connected.');
    }
    try {
        const imgBuffer = await qrcode.toBuffer(qrCodeRaw, { type: 'png', width: 320, margin: 2 });
        res.setHeader('Content-Type', 'image/png');
        res.send(imgBuffer);
    } catch (err) {
        res.status(500).send('Failed to generate QR image');
    }
});

// 5. Get List of WhatsApp Groups (Protected)
app.get('/groups', requireAuth, async (req, res) => {
    if (connectionStatus !== 'connected' || !sock) {
        return res.status(400).json({ success: false, message: 'WhatsApp is not connected.' });
    }

    try {
        const groupsData = await sock.groupFetchAllParticipating();
        const groupsList = Object.values(groupsData).map(g => ({
            id: g.id,
            name: g.subject,
            participants_count: (g.participants || []).length,
            creation: g.creation
        }));

        res.json({
            success: true,
            total: groupsList.length,
            groups: groupsList
        });
    } catch (err) {
        console.error('Failed to fetch groups:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch groups: ' + err.message });
    }
});

// 6. Send WhatsApp Message (Protected)
app.post('/send-message', requireAuth, async (req, res) => {
    if (connectionStatus !== 'connected' || !sock) {
        return res.status(400).json({ success: false, message: 'WhatsApp is not connected. Please scan QR in Admin portal.' });
    }

    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ success: false, message: 'Parameters "to" (phone/group ID) and "message" are required.' });
    }

    try {
        let jid = to.trim();
        if (!jid.includes('@')) {
            const cleanNumber = jid.replace(/[^0-9]/g, '');
            jid = `${cleanNumber}@s.whatsapp.net`;
        }

        const sent = await sock.sendMessage(jid, { text: message });

        res.json({
            success: true,
            message: 'WhatsApp message sent successfully.',
            message_id: sent?.key?.id || null,
            to: jid
        });
    } catch (err) {
        console.error('Failed to send WhatsApp message:', err);
        res.status(500).json({ success: false, message: 'Failed to send WhatsApp message: ' + err.message });
    }
});

// 7. Logout / Disconnect WhatsApp Session (Protected)
app.post('/logout', requireAuth, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        } catch (e) {}
        await clearAuthFromMongo();
        
        connectionStatus = 'disconnected';
        qrCodeRaw = null;
        qrCodeDataUrl = null;
        connectedUser = null;

        setTimeout(connectToWhatsApp, 1500);

        res.json({ success: true, message: 'WhatsApp session logged out. You can now scan a new QR code.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Logout failed: ' + err.message });
    }
});

// Start Express and initiate Baileys
app.listen(PORT, async () => {
    console.log(`🚀 Attendance WhatsApp Gateway running on port ${PORT}`);
    await initMongo();
    await connectToWhatsApp();
});
