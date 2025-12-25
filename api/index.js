/**
 * Archiflow Backend API for Vercel
 * Express + Firebase Realtime Database + OpenRouter AI
 * With Authentication Middleware
 */
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

// Middleware
app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));

// Initialize Firebase Admin
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

// OpenRouter config
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL_AUDIO = "google/gemini-2.0-flash-001";
const MODEL_TEXT = "google/gemini-2.0-flash-lite-001";

// --- AUTH MIDDLEWARE ---
async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split('Bearer ')[1];
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (error) {
        console.error('Token verification failed:', error.message);
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Optional auth - doesn't fail if no token
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split('Bearer ')[1];
        try {
            req.user = await admin.auth().verifyIdToken(token);
        } catch (e) {
            // Ignore invalid token for optional auth
        }
    }
    next();
}

// --- PROMPTS ---
const TRANSCRIPTION_PROMPT = `Trascrivi accuratamente l'audio in italiano.
Mantieni la punteggiatura corretta e i paragrafi dove necessario.
Se ci sono termini tecnici di edilizia/architettura, usali correttamente.
Restituisci SOLO il testo trascritto, nient'altro.`;

const REPORT_GENERATION_PROMPT = `<role>
Sei un architetto esperto in redazione di relazioni tecniche di cantiere.
</role>

<task>
Genera una relazione tecnica HTML professionale basata sulla trascrizione del sopralluogo vocale.
</task>

<input_data>
- Progetto: {project_title}
- Titolo Relazione: {report_title}
- Data: {date}
- Aree ispezionate: {areas}
- Trascrizione vocale:
{transcription}
</input_data>

<output_requirements>
Genera un documento HTML completo con:
1. Struttura: DOCTYPE html con lang="it", CSS variables, stile professionale
2. Contenuto: Header, Oggetto del Sopralluogo, Sezioni per area, Osservazioni, Conclusioni, Firma
3. Stile: Font professionale, colori sobri, boxes con bordo
4. Placeholder per foto per ogni area
</output_requirements>

<rules>
- Scrivi in italiano professionale
- Espandi i concetti dalla trascrizione
- NO markdown, solo HTML valido
- Inizia con <!DOCTYPE html>
</rules>`;

const REFINE_PROMPT = `<role>
Sei un assistente tecnico. MODIFICA un documento HTML esistente secondo le istruzioni.
</role>

<critical_rules>
1. NON INVENTARE INFORMAZIONI
2. PRESERVA IL CONTENUTO non richiesto
3. MODIFICHE MINIME
4. MANTIENI STRUTTURA HTML/CSS
</critical_rules>

<current_document>
{current_html}
</current_document>

<user_request>
{user_message}
</user_request>

Restituisci SOLO l'HTML modificato, senza spiegazioni.`;

const PDF_TEMPLATE_PROMPT = `<role>
Sei un esperto front-end developer specializzato in conversione PDF-to-HTML.
</role>

<objective>
Crea un template HTML5 professionale riutilizzabile.
</objective>

<requirements>
1. CSS Variables per colori in :root
2. Placeholder: {{title}}, {{date}}, {{content}}
3. Media query per stampa
4. NO markdown, solo HTML
</requirements>

<critical_output_rules>
RESTITUISCI SOLO IL CODICE HTML.
- NESSUN testo introduttivo
- Inizia con <!DOCTYPE html>
- Termina con </html>
</critical_output_rules>`;

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
        throw new Error(`OpenRouter error: ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

function cleanHtmlResponse(html) {
    let cleaned = html;
    if (cleaned.startsWith("```html")) cleaned = cleaned.slice(7);
    if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    return cleaned.trim();
}

async function useCredits(userId, amount) {
    if (!db) return false;
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    const user = snapshot.val();
    if (!user) return false;

    const available = (user.creditsTotal || 100) - (user.creditsUsed || 0);
    if (available < amount) return false;

    await userRef.update({ creditsUsed: (user.creditsUsed || 0) + amount });
    return true;
}

// --- PUBLIC ENDPOINTS ---

app.get("/api/health", (req, res) => {
    res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        firebase: db ? "connected" : "not configured",
        ai: OPENROUTER_API_KEY ? "configured" : "not configured"
    });
});

app.get("/api/ai/health", (req, res) => {
    res.json({
        status: "ok",
        apiKeyConfigured: !!OPENROUTER_API_KEY,
        audioModel: MODEL_AUDIO,
        textModel: MODEL_TEXT
    });
});

// --- PROTECTED ENDPOINTS (require auth) ---

// USERS
app.get("/api/users/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });

    // Can only access own user data
    if (req.params.id !== req.user.uid) {
        return res.status(403).json({ error: "Access denied" });
    }

    try {
        const snapshot = await db.ref(`users/${req.params.id}`).once("value");
        const user = snapshot.val();
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.put("/api/users/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    if (req.params.id !== req.user.uid) {
        return res.status(403).json({ error: "Access denied" });
    }

    try {
        const updates = req.body;
        delete updates.id; // Can't change ID
        delete updates.creditsTotal; // Can't change total credits
        await db.ref(`users/${req.params.id}`).update(updates);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

// PROJECTS
app.get("/api/projects", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref("projects")
            .orderByChild("userId")
            .equalTo(req.user.uid)
            .once("value");
        res.json(snapshot.val() ? Object.values(snapshot.val()) : []);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/projects", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const { id, title, description, color } = req.body;
        if (!id || !title) return res.status(400).json({ error: "Missing fields" });

        const newProject = {
            id,
            title,
            description,
            color,
            userId: req.user.uid, // Always use authenticated user
            createdAt: new Date().toISOString()
        };
        await db.ref(`projects/${id}`).set(newProject);
        res.status(201).json(newProject);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.get("/api/projects/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref(`projects/${req.params.id}`).once("value");
        const project = snapshot.val();
        if (!project) return res.status(404).json({ error: "Project not found" });
        if (project.userId !== req.user.uid) return res.status(403).json({ error: "Access denied" });
        res.json(project);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.delete("/api/projects/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref(`projects/${req.params.id}`).once("value");
        const project = snapshot.val();
        if (!project) return res.status(404).json({ error: "Project not found" });
        if (project.userId !== req.user.uid) return res.status(403).json({ error: "Access denied" });

        await db.ref(`projects/${req.params.id}`).remove();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

// CALLS
app.get("/api/calls", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref("calls")
            .orderByChild("userId")
            .equalTo(req.user.uid)
            .once("value");
        res.json(snapshot.val() ? Object.values(snapshot.val()) : []);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/calls", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const { id, title, projectId, transcript, summary, reportHtml, areas, images, roomTitle } = req.body;
        if (!id || !projectId) return res.status(400).json({ error: "Missing fields" });

        const newCall = {
            id,
            title: title || roomTitle,
            roomTitle,
            projectId,
            transcript,
            summary,
            reportHtml,
            areas,
            images,
            userId: req.user.uid,
            createdAt: new Date().toISOString()
        };
        await db.ref(`calls/${id}`).set(newCall);
        res.status(201).json(newCall);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.get("/api/calls/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref(`calls/${req.params.id}`).once("value");
        const call = snapshot.val();
        if (!call) return res.status(404).json({ error: "Call not found" });
        if (call.userId !== req.user.uid) return res.status(403).json({ error: "Access denied" });
        res.json(call);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.put("/api/calls/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref(`calls/${req.params.id}`).once("value");
        const call = snapshot.val();
        if (!call) return res.status(404).json({ error: "Call not found" });
        if (call.userId !== req.user.uid) return res.status(403).json({ error: "Access denied" });

        const updates = req.body;
        delete updates.id;
        delete updates.userId;
        await db.ref(`calls/${req.params.id}`).update(updates);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.delete("/api/calls/:id", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref(`calls/${req.params.id}`).once("value");
        const call = snapshot.val();
        if (!call) return res.status(404).json({ error: "Call not found" });
        if (call.userId !== req.user.uid) return res.status(403).json({ error: "Access denied" });

        await db.ref(`calls/${req.params.id}`).remove();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

// TEMPLATES
app.get("/api/templates", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref("templates")
            .orderByChild("userId")
            .equalTo(req.user.uid)
            .once("value");
        res.json(snapshot.val() ? Object.values(snapshot.val()) : []);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/templates", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const { id, name, description, htmlContent } = req.body;
        if (!id || !name) return res.status(400).json({ error: "Missing fields" });

        const newTemplate = {
            id,
            name,
            description,
            htmlContent,
            userId: req.user.uid,
            createdAt: new Date().toISOString()
        };
        await db.ref(`templates/${id}`).set(newTemplate);
        res.status(201).json(newTemplate);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

// USER STATS
app.get("/api/users/:id/stats", verifyToken, async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    if (req.params.id !== req.user.uid) {
        return res.status(403).json({ error: "Access denied" });
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
            creditsUsed: user.creditsUsed || 0,
            creditsTotal: user.creditsTotal || 100,
            creditsAvailable: (user.creditsTotal || 100) - (user.creditsUsed || 0),
            projectCount: projects.length,
            callCount: calls.length,
            plan: user.plan || 'Free'
        });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

// --- AI ENDPOINTS (require auth + use credits) ---

app.post("/api/ai/transcribe", verifyToken, async (req, res) => {
    try {
        const { audio, mimeType = "audio/webm" } = req.body;
        if (!audio) {
            return res.status(400).json({ error: "No audio data provided" });
        }

        // Check and use credits (1 credit per transcription)
        const hasCredits = await useCredits(req.user.uid, 1);
        if (!hasCredits) {
            return res.status(402).json({ error: "Crediti insufficienti" });
        }

        const result = await callOpenRouter([{
            role: "user",
            content: [
                { type: "text", text: TRANSCRIPTION_PROMPT },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${audio}` } }
            ]
        }], MODEL_AUDIO, 4000);

        res.json({ success: true, transcription: result });
    } catch (error) {
        console.error("Transcribe error:", error);
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/ai/generate-report", verifyToken, async (req, res) => {
    try {
        const { projectTitle, reportTitle, transcription, areas, writingStyle = "standard" } = req.body;
        if (!transcription) return res.status(400).json({ error: "Transcription required" });

        // Check and use credits (2 credits per report)
        const hasCredits = await useCredits(req.user.uid, 2);
        if (!hasCredits) {
            return res.status(402).json({ error: "Crediti insufficienti" });
        }

        const prompt = REPORT_GENERATION_PROMPT
            .replace("{project_title}", projectTitle || "Progetto")
            .replace("{report_title}", reportTitle || "Relazione Tecnica")
            .replace("{date}", new Date().toLocaleDateString("it-IT"))
            .replace("{areas}", JSON.stringify(areas || []))
            .replace("{transcription}", transcription);

        const html = await callOpenRouter([
            { role: "user", content: prompt }
        ], MODEL_TEXT, 16000);

        res.json({ success: true, html: cleanHtmlResponse(html), reportId: `report-${Date.now()}` });
    } catch (error) {
        console.error("Generate report error:", error);
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/ai/refine-report", verifyToken, async (req, res) => {
    try {
        const { currentHtml, userMessage } = req.body;
        if (!currentHtml || !userMessage) {
            return res.status(400).json({ error: "currentHtml and userMessage required" });
        }

        // Check and use credits (1 credit per refinement)
        const hasCredits = await useCredits(req.user.uid, 1);
        if (!hasCredits) {
            return res.status(402).json({ error: "Crediti insufficienti" });
        }

        const prompt = REFINE_PROMPT
            .replace("{current_html}", currentHtml)
            .replace("{user_message}", userMessage);

        const result = await callOpenRouter([
            { role: "user", content: prompt }
        ], MODEL_TEXT, 16000);

        if (result.startsWith("CLARIFICATION:")) {
            res.json({ success: true, needsClarification: true, message: result.replace("CLARIFICATION:", "").trim() });
        } else {
            res.json({ success: true, html: cleanHtmlResponse(result) });
        }
    } catch (error) {
        console.error("Refine report error:", error);
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/ai/convert-pdf", verifyToken, async (req, res) => {
    try {
        // Check and use credits (1 credit per conversion)
        const hasCredits = await useCredits(req.user.uid, 1);
        if (!hasCredits) {
            return res.status(402).json({ error: "Crediti insufficienti" });
        }

        const html = await callOpenRouter([
            { role: "user", content: PDF_TEMPLATE_PROMPT }
        ], MODEL_TEXT, 8000);

        res.json({ success: true, html: cleanHtmlResponse(html) });
    } catch (error) {
        console.error("Convert PDF error:", error);
        res.status(500).json({ error: String(error) });
    }
});

// Export for Vercel
module.exports = app;

// Local development
if (require.main === module) {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}
