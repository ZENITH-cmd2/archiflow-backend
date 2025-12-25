/**
 * Archiflow Backend API for Vercel
 * Express + Firebase Realtime Database + OpenRouter AI
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

1. **Struttura**:
   - <!DOCTYPE html> con lang="it"
   - CSS variables per colori e font in :root
   - Stile professionale con sfondo chiaro e pagina bianca
   - Layout responsive

2. **Contenuto**:
   - Header con titolo, progetto e data
   - Sezione "Oggetto del Sopralluogo" con elenco aree
   - Sezioni per ogni area con descrizione dettagliata
   - Sezione "Osservazioni Tecniche" con eventuali criticità
   - Sezione "Conclusioni e Raccomandazioni"
   - Area firma in fondo

3. **Stile**:
   - Font professionale (Segoe UI, Roboto)
   - Colori sobri (blu scuro per accent, grigi per testo)
   - Boxes con bordo laterale per evidenziare
   - Tabelle stilizzate se necessario

4. **Placeholder per foto**:
   Per ogni area, includi placeholder per foto:
   <div class="photo-grid">
     <div class="photo-placeholder">Foto 1 - [Area]</div>
     <div class="photo-placeholder">Foto 2 - [Area]</div>
   </div>
</output_requirements>

<rules>
- Scrivi in italiano professionale
- Espandi i concetti menzionati nella trascrizione
- Usa terminologia tecnica appropriata
- NO markdown, solo HTML valido
- Inizia con <!DOCTYPE html>
</rules>`;

const REFINE_PROMPT = `<role>
Sei un assistente tecnico esperto in relazioni di cantiere. Il tuo compito è MODIFICARE un documento HTML esistente secondo le istruzioni dell'utente.
</role>

<critical_rules>
1. **NON INVENTARE INFORMAZIONI**: Modifica SOLO ciò che l'utente chiede esplicitamente
2. **PRESERVA IL CONTENUTO**: Mantieni tutto il resto del documento INTATTO
3. **MODIFICHE MINIME**: Fai solo le modifiche richieste, niente di più
4. **NO ALLUCINAZIONI**: Se l'utente chiede qualcosa di ambiguo, chiedi chiarimenti invece di inventare
5. **MANTIENI STRUTTURA**: Non cambiare la struttura HTML/CSS se non richiesto
</critical_rules>

<current_document>
{current_html}
</current_document>

<user_request>
{user_message}
</user_request>

<instructions>
Analizza la richiesta dell'utente e applica SOLO le modifiche richieste al documento.
Se la richiesta è poco chiara, rispondi con un messaggio che inizia con "CLARIFICATION:" seguito dalla domanda.
Altrimenti, restituisci il documento HTML completo modificato.
NON aggiungere spiegazioni, restituisci SOLO l'HTML.
</instructions>`;

const PDF_TEMPLATE_PROMPT = `<role>
Sei un esperto front-end developer specializzato in conversione PDF-to-HTML pixel-perfect.
</role>

<objective>
Trasforma il contenuto PDF in un template HTML5 professionale riutilizzabile con:
1. Fedeltà visiva al 95%+
2. Codice semantico e mantenibile  
3. Placeholder Jinja2/Mustache per riuso
</objective>

<requirements>
1. CSS Variables per tutti i colori in :root
2. Placeholder doppia parentesi graffa: {{title}}, {{date}}, {{content}}
3. Media query per stampa
4. NO markdown, solo HTML puro
5. Inizia con <!DOCTYPE html>
</requirements>`;

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

// --- ENDPOINTS ---

/**
 * Health Check
 */
app.get("/api/health", (req, res) => {
    res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        firebase: db ? "connected" : "not configured",
        ai: OPENROUTER_API_KEY ? "configured" : "not configured"
    });
});

/**
 * AI Health Check
 */
app.get("/api/ai/health", (req, res) => {
    res.json({
        status: "ok",
        apiKeyConfigured: !!OPENROUTER_API_KEY,
        audioModel: MODEL_AUDIO,
        textModel: MODEL_TEXT
    });
});

/**
 * USERS
 */
app.get("/api/users", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref("users").once("value");
        res.json(snapshot.val() ? Object.values(snapshot.val()) : []);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.get("/api/users/:id", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref(`users/${req.params.id}`).once("value");
        const user = snapshot.val();
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/users", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const { id, email, name, plan, creditsTotal, avatar } = req.body;
        if (!id || !email) return res.status(400).json({ error: "Missing required fields" });
        const newUser = {
            id, email: email.toLowerCase().trim(), name, plan, creditsTotal,
            creditsUsed: 0, avatar, createdAt: new Date().toISOString()
        };
        await db.ref(`users/${id}`).set(newUser);
        res.status(201).json(newUser);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

/**
 * PROJECTS
 */
app.get("/api/projects", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref("projects").once("value");
        res.json(snapshot.val() ? Object.values(snapshot.val()) : []);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/projects", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const { id, title, description, color, userId } = req.body;
        if (!id || !title || !userId) return res.status(400).json({ error: "Missing fields" });
        const newProject = { id, title, description, color, userId, createdAt: new Date().toISOString() };
        await db.ref(`projects/${id}`).set(newProject);
        res.status(201).json(newProject);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

/**
 * CALLS
 */
app.get("/api/calls", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref("calls").once("value");
        res.json(snapshot.val() ? Object.values(snapshot.val()) : []);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/calls", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const { id, title, projectId, transcript, summary, reportHtml, areas, images } = req.body;
        if (!id || !projectId) return res.status(400).json({ error: "Missing fields" });
        const newCall = {
            id, title, projectId, transcript, summary, reportHtml, areas, images,
            createdAt: new Date().toISOString()
        };
        await db.ref(`calls/${id}`).set(newCall);
        res.status(201).json(newCall);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.get("/api/calls/:id", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref(`calls/${req.params.id}`).once("value");
        const call = snapshot.val();
        if (!call) return res.status(404).json({ error: "Call not found" });
        res.json(call);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

/**
 * TEMPLATES
 */
app.get("/api/templates", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const snapshot = await db.ref("templates").once("value");
        res.json(snapshot.val() ? Object.values(snapshot.val()) : []);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.post("/api/templates", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not configured" });
    try {
        const { id, name, description, htmlContent, userId } = req.body;
        if (!id || !name) return res.status(400).json({ error: "Missing fields" });
        const newTemplate = { id, name, description, htmlContent, userId, createdAt: new Date().toISOString() };
        await db.ref(`templates/${id}`).set(newTemplate);
        res.status(201).json(newTemplate);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

/**
 * AI - Transcribe Audio
 */
app.post("/api/ai/transcribe", async (req, res) => {
    try {
        const { audio, mimeType = "audio/webm" } = req.body;

        if (!audio) {
            return res.status(400).json({ error: "No audio data provided" });
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

/**
 * AI - Generate Report
 */
app.post("/api/ai/generate-report", async (req, res) => {
    try {
        const { projectTitle, reportTitle, transcription, areas, writingStyle = "standard" } = req.body;
        if (!transcription) return res.status(400).json({ error: "Transcription required" });

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

/**
 * AI - Refine Report
 */
app.post("/api/ai/refine-report", async (req, res) => {
    try {
        const { currentHtml, userMessage } = req.body;
        if (!currentHtml || !userMessage) {
            return res.status(400).json({ error: "currentHtml and userMessage required" });
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

/**
 * AI - Convert PDF to HTML Template
 */
app.post("/api/ai/convert-pdf", async (req, res) => {
    try {
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
