/**
 * Archiflow Backend API for Vercel
 * Express + Firebase Realtime Database
 */
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

// Middleware
app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));

// Initialize Firebase Admin (use environment variable for credentials)
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

/**
 * Health Check
 */
app.get("/api/health", (req, res) => {
    res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        firebase: db ? "connected" : "not configured"
    });
});

/**
 * AI Health Check
 */
app.get("/api/ai/health", (req, res) => {
    res.json({
        status: "ok",
        apiKeyConfigured: !!OPENROUTER_API_KEY,
        model: "google/gemini-2.0-flash-lite-001"
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
        const { id, title, projectId, transcript, summary } = req.body;
        if (!id || !projectId) return res.status(400).json({ error: "Missing fields" });
        const newCall = { id, title, projectId, transcript, summary, createdAt: new Date().toISOString() };
        await db.ref(`calls/${id}`).set(newCall);
        res.status(201).json(newCall);
    } catch (error) {
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

        const prompt = `Sei un architetto. Genera una relazione tecnica HTML professionale.
Progetto: ${projectTitle}. Titolo: ${reportTitle || "Relazione Tecnica"}.
Aree: ${JSON.stringify(areas || [])}. Stile: ${writingStyle}.
Trascrizione: ${transcription}
Genera HTML completo con DOCTYPE, CSS inline, struttura professionale italiana.`;

        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "google/gemini-2.0-flash-lite-001",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3,
                max_tokens: 16000
            })
        });

        const data = await response.json();
        let html = data.choices?.[0]?.message?.content || "";
        if (html.startsWith("```html")) html = html.slice(7);
        if (html.endsWith("```")) html = html.slice(0, -3);

        res.json({ success: true, html, reportId: `report-${Date.now()}` });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

/**
 * AI - Convert PDF to HTML Template
 */
app.post("/api/ai/convert-pdf", async (req, res) => {
    try {
        // For now, return a placeholder response since PDF parsing requires special handling
        // In production, you'd use a PDF parser and then AI to generate HTML
        const prompt = `Genera un template HTML professionale per una relazione tecnica architettonica.
Include: intestazione, corpo con sezioni, piè di pagina.
Usa placeholder {{TITOLO}}, {{DATA}}, {{CONTENUTO}}, {{AUTORE}}.
Genera HTML completo con DOCTYPE e CSS inline professionale.`;

        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "google/gemini-2.0-flash-lite-001",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3,
                max_tokens: 8000
            })
        });

        const data = await response.json();
        let html = data.choices?.[0]?.message?.content || "";
        if (html.startsWith("```html")) html = html.slice(7);
        if (html.endsWith("```")) html = html.slice(0, -3);

        res.json({ success: true, html });
    } catch (error) {
        console.error("Convert PDF error:", error);
        res.status(500).json({ error: String(error) });
    }
});

/**
 * AI - Transcribe Audio
 * Accepts multipart/form-data with audio file
 */
app.post("/api/ai/transcribe", async (req, res) => {
    try {
        // For Vercel serverless, we need to handle the raw body
        // The audio should be sent as base64 in the request body
        const { audio, mimeType = "audio/webm" } = req.body;

        if (!audio) {
            return res.status(400).json({ error: "No audio data provided. Send base64 audio in 'audio' field." });
        }

        // Call OpenRouter with audio (Gemini supports audio)
        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "google/gemini-2.0-flash-001",
                messages: [{
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Trascrivi questo audio in italiano. Restituisci SOLO il testo trascritto, nient'altro."
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${audio}`
                            }
                        }
                    ]
                }],
                temperature: 0.1,
                max_tokens: 4000
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error("OpenRouter error:", data.error);
            return res.status(500).json({ error: data.error.message || "Transcription failed" });
        }

        const transcription = data.choices?.[0]?.message?.content || "";
        res.json({ success: true, transcription });
    } catch (error) {
        console.error("Transcribe error:", error);
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
