/**
 * Archiflow Backend API v2.0
 * Express + Firebase Realtime Database + OpenRouter AI
 * 
 * Features:
 * - JWT Authentication with Firebase
 * - Credit system with monthly reset
 * - Rate limiting
 * - Input validation
 * - Professional AI prompts
 * - Comprehensive error handling
 */
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

// --- MIDDLEWARE ---
app.use(cors({
    origin: [
        'https://archiflow-84df3.web.app',
        'https://archiflow-84df3.firebaseapp.com',
        'http://localhost:3000',
        'http://localhost:5173'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.use(express.json({ limit: "50mb" }));

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// --- FIREBASE INIT ---
let db = null;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    if (serviceAccount.project_id) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
        db = admin.database();
        console.log("✅ Firebase initialized");
    }
} catch (e) {
    console.warn("⚠️ Firebase not configured:", e.message);
}

// --- OPENROUTER CONFIG ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL_AUDIO = "google/gemini-2.0-flash-001";
const MODEL_TEXT = "google/gemini-2.0-flash-lite-001";

// --- RATE LIMITING (in-memory, resets on deploy) ---
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute

function checkRateLimit(userId) {
    const now = Date.now();
    const userLimits = rateLimits.get(userId) || { count: 0, windowStart: now };

    if (now - userLimits.windowStart > RATE_LIMIT_WINDOW) {
        // Reset window
        userLimits.count = 1;
        userLimits.windowStart = now;
    } else {
        userLimits.count++;
    }

    rateLimits.set(userId, userLimits);
    return userLimits.count <= RATE_LIMIT_MAX_REQUESTS;
}

// --- AUTH MIDDLEWARE ---
async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token di autenticazione mancante' });
    }

    const token = authHeader.split('Bearer ')[1];
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;

        // Rate limiting
        if (!checkRateLimit(decoded.uid)) {
            return res.status(429).json({ error: 'Troppe richieste. Riprova tra un minuto.' });
        }

        next();
    } catch (error) {
        console.error('Token verification failed:', error.message);
        return res.status(401).json({ error: 'Token non valido o scaduto' });
    }
}

// --- AI PROMPTS ---
const PROMPTS = {
    transcription: `Sei un assistente professionale per architetti e geometri italiani.
Trascrivi accuratamente l'audio fornito in italiano.

REGOLE:
1. Mantieni la punteggiatura corretta e i paragrafi dove necessario
2. Usa correttamente i termini tecnici di edilizia/architettura
3. Correggi eventuali errori grammaticali evidenti
4. Formatta il testo in modo leggibile

IMPORTANTE: Restituisci SOLO il testo trascritto, senza introduzioni o commenti.`,

    reportGeneration: `<role>
Sei un architetto senior italiano esperto in redazione di relazioni tecniche di cantiere.
Hai 20+ anni di esperienza nella stesura di documenti tecnici professionali.
</role>

<task>
Genera una RELAZIONE TECNICA DI SOPRALLUOGO completa e professionale in formato HTML.
</task>

<input>
- Progetto: {projectTitle}
- Titolo Relazione: {reportTitle}
- Data Sopralluogo: {date}
- Aree Ispezionate: {areas}
- Note Vocali Trascritte:
{transcription}
</input>

<structure>
1. INTESTAZIONE: Titolo, data, riferimenti progetto
2. PREMESSA: Oggetto del sopralluogo e finalità
3. STATO DEI LAVORI: Descrizione dettagliata per ogni area
4. RILIEVI FOTOGRAFICI: Placeholder per foto
5. OSSERVAZIONI TECNICHE: Problemi riscontrati, soluzioni proposte
6. CONCLUSIONI: Sintesi e prossimi passi
7. FIRMA: Spazio per firma tecnico
</structure>

<style_requirements>
- HTML5 valido con CSS inline professionale
- Font: sistema, colori sobri (grigio/blu scuro)
- Margini adatti alla stampa (2cm)
- Intestazione con logo placeholder
- Numerazione pagine
- Boxes con bordi per sezioni

PER LE IMMAGINI: Genera placeholder con questo ESATTO formato HTML:
<div class="photo-placeholder">[FOTO: Descrizione dell'immagine]</div>

Inserisci questi placeholder nelle sezioni appropriate del documento, vicino alle descrizioni testuali corrispondenti.
</style_requirements>

<rules>
- Scrivi in italiano professionale/tecnico
- ESPANDI le note vocali in descrizioni complete
- NON inventare dati tecnici non menzionati
- Inizia DIRETTAMENTE con <!DOCTYPE html>
- NESSUN markdown, solo HTML puro
- USA il formato <div class="photo-placeholder">[FOTO: descrizione]</div> per i placeholder immagini
</rules>`,

    refineReport: `<role>
Sei un assistente tecnico per documenti di architettura.
Il tuo compito è MODIFICARE un documento HTML esistente secondo le istruzioni dell'utente.
</role>

<critical_rules>
1. NON INVENTARE MAI informazioni non presenti nel documento originale
2. PRESERVA tutto il contenuto non interessato dalla modifica
3. FAI SOLO le modifiche richieste, nient'altro
4. MANTIENI la struttura HTML e il CSS esistente
5. Se la richiesta non è chiara, inizia la risposta con "CLARIFICATION:" e chiedi dettagli
</critical_rules>

<current_document>
{currentHtml}
</current_document>

<user_request>
{userMessage}
</user_request>

IMPORTANTE: Restituisci SOLO l'HTML modificato, senza spiegazioni.`,

    pdfTemplate: `<role>
Sei un esperto front-end developer specializzato in template HTML professionali.
</role>

<objective>
Crea un template HTML5 riutilizzabile per relazioni tecniche.
</objective>

<requirements>
1. CSS Variables in :root per colori/font personalizzabili
2. Placeholder: {{title}}, {{date}}, {{content}}, {{author}}
3. Layout A4 con margini per stampa
4. Header/footer ripetibili
5. Stile professionale e minimale
6. Media query per stampa

IMPORTANTE: Restituisci SOLO codice HTML, iniziando con <!DOCTYPE html>
</requirements>`
};

// --- HELPER FUNCTIONS ---
async function callOpenRouter(messages, model = MODEL_TEXT, maxTokens = 8000) {
    const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://archiflow-84df3.web.app",
            "X-Title": "Archiflow"
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0.3,
            max_tokens: maxTokens
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenRouter error:', errorText);
        throw new Error(`Errore AI: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

function cleanHtmlResponse(html) {
    let cleaned = html.trim();
    // Remove markdown code blocks if present
    if (cleaned.startsWith("```html")) cleaned = cleaned.slice(7);
    if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    return cleaned.trim();
}

async function useCredits(userId, amount) {
    if (!db) return { success: false, error: 'Database non configurato' };

    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    const user = snapshot.val();

    if (!user) return { success: false, error: 'Utente non trovato' };

    const creditsTotal = user.creditsTotal || 10;
    const creditsUsed = user.creditsUsed || 0;
    const available = creditsTotal - creditsUsed;

    if (available < amount) {
        return {
            success: false,
            error: `Crediti insufficienti (${available} disponibili, ${amount} richiesti)`,
            available,
            required: amount
        };
    }

    await userRef.update({ creditsUsed: creditsUsed + amount });
    return { success: true, remaining: available - amount };
}

function validateRequired(body, fields) {
    const missing = fields.filter(f => !body[f]);
    if (missing.length > 0) {
        return { valid: false, error: `Campi mancanti: ${missing.join(', ')}` };
    }
    return { valid: true };
}

// --- PUBLIC ENDPOINTS ---

app.get("/api/health", (req, res) => {
    res.json({
        status: "healthy",
        version: "2.0",
        timestamp: new Date().toISOString(),
        services: {
            firebase: db ? "connected" : "not configured",
            ai: OPENROUTER_API_KEY ? "configured" : "not configured"
        }
    });
});

app.get("/api/ai/health", (req, res) => {
    res.json({
        status: "ok",
        models: {
            audio: MODEL_AUDIO,
            text: MODEL_TEXT
        }
    });
});

// --- USER ENDPOINTS ---

app.get("/api/users/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });
    if (req.params.id !== req.user.uid) {
        return res.status(403).json({ error: "Accesso negato" });
    }

    try {
        const snapshot = await db.ref(`users/${req.params.id}`).once("value");
        const user = snapshot.val();
        if (!user) return res.status(404).json({ error: "Utente non trovato" });
        res.json(user);
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: "Errore interno del server" });
    }
});

app.put("/api/users/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });
    if (req.params.id !== req.user.uid) {
        return res.status(403).json({ error: "Accesso negato" });
    }

    try {
        const allowedFields = ['name', 'avatar'];
        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: "Nessun campo valido da aggiornare" });
        }

        await db.ref(`users/${req.params.id}`).update(updates);
        res.json({ success: true, updated: Object.keys(updates) });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ error: "Errore interno del server" });
    }
});

app.get("/api/users/:id/stats", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });
    if (req.params.id !== req.user.uid) {
        return res.status(403).json({ error: "Accesso negato" });
    }

    try {
        const [userSnap, projectsSnap, callsSnap] = await Promise.all([
            db.ref(`users/${req.user.uid}`).once("value"),
            db.ref("projects").orderByChild("userId").equalTo(req.user.uid).once("value"),
            db.ref("calls").orderByChild("userId").equalTo(req.user.uid).once("value")
        ]);

        const user = userSnap.val() || {};
        const projects = projectsSnap.val() ? Object.values(projectsSnap.val()) : [];
        const calls = callsSnap.val() ? Object.values(callsSnap.val()) : [];

        res.json({
            credits: {
                used: user.creditsUsed || 0,
                total: user.creditsTotal || 10,
                available: (user.creditsTotal || 10) - (user.creditsUsed || 0)
            },
            counts: {
                projects: projects.length,
                calls: calls.length
            },
            plan: user.plan || 'Free',
            memberSince: user.createdAt
        });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ error: "Errore interno del server" });
    }
});

// --- PROJECTS ENDPOINTS ---

app.get("/api/projects", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });
    try {
        const snapshot = await db.ref("projects")
            .orderByChild("userId")
            .equalTo(req.user.uid)
            .once("value");

        const projects = snapshot.val() ? Object.values(snapshot.val()) : [];
        res.json(projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    } catch (error) {
        console.error('Get projects error:', error);
        res.status(500).json({ error: "Errore interno del server" });
    }
});

app.post("/api/projects", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    const validation = validateRequired(req.body, ['id', 'title']);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    try {
        const { id, title, description, color } = req.body;

        const newProject = {
            id,
            title: title.trim(),
            description: description?.trim() || '',
            color: color || '#3B82F6',
            userId: req.user.uid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await db.ref(`projects/${id}`).set(newProject);
        res.status(201).json(newProject);
    } catch (error) {
        console.error('Create project error:', error);
        res.status(500).json({ error: "Errore nella creazione del progetto" });
    }
});

app.delete("/api/projects/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    try {
        const snapshot = await db.ref(`projects/${req.params.id}`).once("value");
        const project = snapshot.val();

        if (!project) return res.status(404).json({ error: "Progetto non trovato" });
        if (project.userId !== req.user.uid) return res.status(403).json({ error: "Accesso negato" });

        await db.ref(`projects/${req.params.id}`).remove();
        res.json({ success: true, message: "Progetto eliminato" });
    } catch (error) {
        console.error('Delete project error:', error);
        res.status(500).json({ error: "Errore nell'eliminazione del progetto" });
    }
});

// --- CALLS ENDPOINTS ---

app.get("/api/calls", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    try {
        let query = db.ref("calls").orderByChild("userId").equalTo(req.user.uid);
        const snapshot = await query.once("value");

        let calls = snapshot.val() ? Object.values(snapshot.val()) : [];

        // Filter by projectId if provided
        if (req.query.projectId) {
            calls = calls.filter(c => c.projectId === req.query.projectId);
        }

        res.json(calls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    } catch (error) {
        console.error('Get calls error:', error);
        res.status(500).json({ error: "Errore interno del server" });
    }
});

app.post("/api/calls", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    const validation = validateRequired(req.body, ['id', 'projectId']);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    try {
        const { id, title, projectId, transcript, summary, reportHtml, areas, images, roomTitle } = req.body;

        const newCall = {
            id,
            title: title || roomTitle || 'Nuova chiamata',
            roomTitle: roomTitle || title,
            projectId,
            transcript: transcript || '',
            summary: summary || '',
            reportHtml: reportHtml || '',
            areas: areas || [],
            images: images || [],
            status: transcript ? 'completed' : 'draft',
            userId: req.user.uid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await db.ref(`calls/${id}`).set(newCall);
        res.status(201).json(newCall);
    } catch (error) {
        console.error('Create call error:', error);
        res.status(500).json({ error: "Errore nella creazione della chiamata" });
    }
});

app.get("/api/calls/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    try {
        const snapshot = await db.ref(`calls/${req.params.id}`).once("value");
        const call = snapshot.val();

        if (!call) return res.status(404).json({ error: "Chiamata non trovata" });
        if (call.userId !== req.user.uid) return res.status(403).json({ error: "Accesso negato" });

        res.json(call);
    } catch (error) {
        console.error('Get call error:', error);
        res.status(500).json({ error: "Errore interno del server" });
    }
});

app.put("/api/calls/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    try {
        const snapshot = await db.ref(`calls/${req.params.id}`).once("value");
        const call = snapshot.val();

        if (!call) return res.status(404).json({ error: "Chiamata non trovata" });
        if (call.userId !== req.user.uid) return res.status(403).json({ error: "Accesso negato" });

        const allowedFields = ['title', 'roomTitle', 'transcript', 'summary', 'reportHtml', 'status'];
        const updates = { updatedAt: new Date().toISOString() };

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        await db.ref(`calls/${req.params.id}`).update(updates);
        res.json({ success: true, updated: Object.keys(updates) });
    } catch (error) {
        console.error('Update call error:', error);
        res.status(500).json({ error: "Errore nell'aggiornamento della chiamata" });
    }
});

app.delete("/api/calls/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    try {
        const snapshot = await db.ref(`calls/${req.params.id}`).once("value");
        const call = snapshot.val();

        if (!call) return res.status(404).json({ error: "Chiamata non trovata" });
        if (call.userId !== req.user.uid) return res.status(403).json({ error: "Accesso negato" });

        await db.ref(`calls/${req.params.id}`).remove();
        res.json({ success: true, message: "Chiamata eliminata" });
    } catch (error) {
        console.error('Delete call error:', error);
        res.status(500).json({ error: "Errore nell'eliminazione della chiamata" });
    }
});

// --- TEMPLATES ENDPOINTS ---

app.get("/api/templates", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    try {
        const snapshot = await db.ref("templates")
            .orderByChild("userId")
            .equalTo(req.user.uid)
            .once("value");
        res.json(snapshot.val() ? Object.values(snapshot.val()) : []);
    } catch (error) {
        console.error('Get templates error:', error);
        res.status(500).json({ error: "Errore interno del server" });
    }
});

app.post("/api/templates", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database non configurato" });

    const validation = validateRequired(req.body, ['id', 'name']);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    try {
        const { id, name, description, htmlContent, category } = req.body;

        const newTemplate = {
            id,
            name: name.trim(),
            description: description?.trim() || '',
            htmlContent: htmlContent || '',
            category: category || 'Custom',
            userId: req.user.uid,
            createdAt: new Date().toISOString()
        };

        await db.ref(`templates/${id}`).set(newTemplate);
        res.status(201).json(newTemplate);
    } catch (error) {
        console.error('Create template error:', error);
        res.status(500).json({ error: "Errore nella creazione del template" });
    }
});

// --- AI ENDPOINTS ---

app.post("/api/ai/transcribe", verifyToken, async (req, res) => {
    try {
        const { audio, mimeType = "audio/webm" } = req.body;

        if (!audio) {
            return res.status(400).json({ error: "Audio mancante" });
        }

        // Check credits
        const creditResult = await useCredits(req.user.uid, 1);
        if (!creditResult.success) {
            return res.status(402).json({
                error: creditResult.error,
                creditsAvailable: creditResult.available,
                creditsRequired: creditResult.required
            });
        }

        const result = await callOpenRouter([{
            role: "user",
            content: [
                { type: "text", text: PROMPTS.transcription },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${audio}` } }
            ]
        }], MODEL_AUDIO, 4000);

        res.json({
            success: true,
            transcription: result,
            creditsRemaining: creditResult.remaining
        });
    } catch (error) {
        console.error("Transcribe error:", error);
        res.status(500).json({ error: "Errore nella trascrizione audio" });
    }
});

app.post("/api/ai/generate-report", verifyToken, async (req, res) => {
    try {
        const { projectTitle, reportTitle, transcription, areas } = req.body;

        if (!transcription) {
            return res.status(400).json({ error: "Trascrizione mancante" });
        }

        // Check credits
        const creditResult = await useCredits(req.user.uid, 1);
        if (!creditResult.success) {
            return res.status(402).json({
                error: creditResult.error,
                creditsAvailable: creditResult.available
            });
        }

        const prompt = PROMPTS.reportGeneration
            .replace("{projectTitle}", projectTitle || "Progetto")
            .replace("{reportTitle}", reportTitle || "Relazione Tecnica di Sopralluogo")
            .replace("{date}", new Date().toLocaleDateString("it-IT", {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            }))
            .replace("{areas}", JSON.stringify(areas || []))
            .replace("{transcription}", transcription);

        const html = await callOpenRouter([
            { role: "user", content: prompt }
        ], MODEL_TEXT, 16000);

        res.json({
            success: true,
            html: cleanHtmlResponse(html),
            reportId: `report-${Date.now()}`,
            creditsRemaining: creditResult.remaining
        });
    } catch (error) {
        console.error("Generate report error:", error);
        res.status(500).json({ error: "Errore nella generazione del report" });
    }
});

app.post("/api/ai/refine-report", verifyToken, async (req, res) => {
    try {
        const { currentHtml, userMessage } = req.body;

        if (!currentHtml || !userMessage) {
            return res.status(400).json({ error: "HTML corrente e messaggio utente richiesti" });
        }

        // Check credits
        const creditResult = await useCredits(req.user.uid, 1);
        if (!creditResult.success) {
            return res.status(402).json({ error: creditResult.error });
        }

        const prompt = PROMPTS.refineReport
            .replace("{currentHtml}", currentHtml)
            .replace("{userMessage}", userMessage);

        const result = await callOpenRouter([
            { role: "user", content: prompt }
        ], MODEL_TEXT, 16000);

        if (result.startsWith("CLARIFICATION:")) {
            res.json({
                success: true,
                needsClarification: true,
                message: result.replace("CLARIFICATION:", "").trim()
            });
        } else {
            res.json({
                success: true,
                html: cleanHtmlResponse(result),
                creditsRemaining: creditResult.remaining
            });
        }
    } catch (error) {
        console.error("Refine report error:", error);
        res.status(500).json({ error: "Errore nella modifica del report" });
    }
});

app.post("/api/ai/convert-pdf", verifyToken, async (req, res) => {
    try {
        // Check credits
        const creditResult = await useCredits(req.user.uid, 1);
        if (!creditResult.success) {
            return res.status(402).json({ error: creditResult.error });
        }

        const html = await callOpenRouter([
            { role: "user", content: PROMPTS.pdfTemplate }
        ], MODEL_TEXT, 8000);

        res.json({
            success: true,
            html: cleanHtmlResponse(html),
            creditsRemaining: creditResult.remaining
        });
    } catch (error) {
        console.error("Convert PDF error:", error);
        res.status(500).json({ error: "Errore nella conversione PDF" });
    }
});

// --- ERROR HANDLER ---
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Errore interno del server' });
});

// --- 404 HANDLER ---
app.use((req, res) => {
    res.status(404).json({ error: `Endpoint non trovato: ${req.method} ${req.path}` });
});

// Export for Vercel
module.exports = app;

// Local development
if (require.main === module) {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}
