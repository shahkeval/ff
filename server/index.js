require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const app = express();
app.use(cors());
app.use(express.json());

// Serve the frontend from the SAME origin as the API. Opening the tool via
// file:// works for the local-fallback parser, but modern browsers block
// file:// pages from fetching http://localhost resources (private-network-
// access restrictions) regardless of CORS headers — that's why uploads were
// silently falling back to "extracted locally, backend not used". Serving
// both from http://localhost:PORT removes the cross-origin boundary entirely.
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "Advantedge Operations v3.0.41_1.html")));
app.get("/sections", (req, res) => res.sendFile(path.join(ROOT, "section-upload.html")));
app.use("/synthetic-data", express.static(path.join(ROOT, "Synthetic Data")));
// Read-only reference data (operand registry, KPI formulas/benchmarks) for the
// section-upload UI's "show your work" breakdown — not sensitive, no DB access.
app.get("/engine-data/operand-registry.json", (req, res) => res.sendFile(path.join(ROOT, "engine", "operand-registry.json")));
app.get("/engine-data/kpi-catalog.json", (req, res) => res.sendFile(path.join(ROOT, "engine", "kpi-catalog.json")));

app.get("/api/health", (req, res) => res.json({ ok: true, openaiConfigured: !!process.env.OPENAI_API_KEY }));

app.use("/api/communities", require("./routes/communities"));
app.use("/api/communities", require("./routes/documents"));
app.use("/api/communities", require("./routes/kpis"));
app.use("/api/benchmarks", require("./routes/benchmarks"));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Advantedge Operations backend listening on http://localhost:${PORT}`);
  console.log(`OpenAI extraction: ${process.env.OPENAI_API_KEY ? "configured" : "NOT configured (set OPENAI_API_KEY env var)"}`);
});
