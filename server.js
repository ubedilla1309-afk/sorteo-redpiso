const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const dotenv = require("dotenv");
const QRCode = require("qrcode");
const Database = require("better-sqlite3");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "CAMBIA_ESTO";

const PROMO_TITLE = process.env.PROMO_TITLE || "Sorteo RedPiso: ¡Un viaje para 2!";
const PROMO_SUBTITLE =
  process.env.PROMO_SUBTITLE ||
  "Déjanos tu dirección, síguenos en redes y te damos 1 participación cuando vayamos a valorar tu vivienda (sin compromiso). Solo 50 plazas.";

const IG_URL =
  process.env.IG_URL ||
  "https://www.instagram.com/redpisofuenlabradacentro?igsh=MXI1bHQzaXplazkydg==";
const TT_URL = process.env.TT_URL || "https://www.tiktok.com/@redpisofuenlabradacentro";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "db.sqlite"));
db.pragma("journal_mode = WAL");

// Tabla base
db.exec(`
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  followed_socials INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS draw (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  winner_entry_id INTEGER,
  drawn_at TEXT
);

INSERT OR IGNORE INTO draw (id, winner_entry_id, drawn_at) VALUES (1, NULL, NULL);
`);

// Migración por si venías de versión antigua (con valuation_eur)
function columnExists(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === col);
}
if (!columnExists("entries", "address")) {
  db.exec(`ALTER TABLE entries ADD COLUMN address TEXT NOT NULL DEFAULT ''`);
}
if (columnExists("entries", "valuation_eur")) {
  // No borramos columna para no romper datos antiguos, solo dejamos de usarla
}

function normalizePhone(raw) {
  return String(raw || "").trim().replace(/[^\d+]/g, "");
}
function isValidPhone(phone) {
  const p = phone.replace(/\s/g, "");
  return /^(\+?34)?\d{9}$/.test(p);
}

function getStats() {
  const total = db.prepare(`SELECT COUNT(*) as c FROM entries`).get().c;
  const remaining = Math.max(0, 50 - total);
  const drawRow = db.prepare(`SELECT winner_entry_id, drawn_at FROM draw WHERE id=1`).get();
  const winner = drawRow.winner_entry_id
    ? db.prepare(`SELECT * FROM entries WHERE id=?`).get(drawRow.winner_entry_id)
    : null;
  return { total, remaining, isFull: total >= 50, winner, drawn_at: drawRow.drawn_at };
}

async function ensureQr() {
  const outPath = path.join(__dirname, "public", "qr.png");
  const url = `${PUBLIC_URL}/`;
  const png = await QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 420,
    color: { dark: "#d40000", light: "#ffffff" }
  });
  fs.writeFileSync(outPath, png);
}

app.get("/", (req, res) => {
  const stats = getStats();
  res.render("index", {
    stats,
    PROMO_TITLE,
    PROMO_SUBTITLE,
    PUBLIC_URL,
    IG_URL,
    TT_URL,
    q: req.query
  });
});

app.post("/participar", (req, res) => {
  const stats = getStats();
  if (stats.isFull) return res.redirect("/?full=1");

  const first_name = String(req.body.first_name || "").trim();
  const last_name = String(req.body.last_name || "").trim();
  const phone = normalizePhone(req.body.phone);
  const address = String(req.body.address || "").trim();
  const followed_socials = req.body.followed_socials === "on" ? 1 : 0;

  const errors = [];
  if (first_name.length < 2) errors.push("Pon tu nombre.");
  if (last_name.length < 2) errors.push("Pon tus apellidos.");
  if (!isValidPhone(phone)) errors.push("Teléfono no válido (formato España).");
  if (address.length < 8) errors.push("Pon una dirección válida (mínimo 8 caracteres).");
  if (!followed_socials) errors.push("Debes confirmar que nos sigues en Instagram o TikTok.");

  const exists = db.prepare(`SELECT id FROM entries WHERE phone=?`).get(phone);
  if (exists) errors.push("Ese teléfono ya está participando.");

  if (errors.length) return res.redirect(`/?err=${encodeURIComponent(errors.join(" | "))}`);

  db.prepare(`
    INSERT INTO entries (first_name, last_name, phone, address, followed_socials)
    VALUES (?, ?, ?, ?, ?)
  `).run(first_name, last_name, phone, address, followed_socials);

  return res.render("thanks", { stats: getStats(), PROMO_TITLE });
});

// Admin: sortear (solo cuando haya 50)
app.get("/admin/draw", (req, res) => {
  if (String(req.query.token || "") !== ADMIN_TOKEN) return res.status(401).send("No autorizado.");

  const stats = getStats();
  if (stats.winner) return res.send("Ya hay ganador. Revisa la landing.");
  if (stats.total < 50) return res.status(400).send(`Aún no. Participaciones: ${stats.total}/50`);

  const entries = db.prepare(`SELECT id FROM entries`).all();
  const picked = entries[Math.floor(Math.random() * entries.length)];

  db.prepare(`UPDATE draw SET winner_entry_id=?, drawn_at=datetime('now') WHERE id=1`).run(picked.id);

  const winner = db.prepare(`SELECT * FROM entries WHERE id=?`).get(picked.id);
  res.send(`Ganador: ${winner.first_name} ${winner.last_name} (tel: ${winner.phone})`);
});

// Admin: export CSV
app.get("/admin/export.csv", (req, res) => {
  if (String(req.query.token || "") !== ADMIN_TOKEN) return res.status(401).send("No autorizado.");

  const rows = db.prepare(`SELECT * FROM entries ORDER BY created_at ASC`).all();
  const header = "id,first_name,last_name,phone,address,followed_socials,created_at\n";
  const lines = rows.map(r =>
    [r.id, r.first_name, r.last_name, r.phone, r.address, r.followed_socials, r.created_at]
      .map(v => `"${String(v).replaceAll('"', '""')}"`)
      .join(",")
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=participantes-redpiso.csv");
  res.send(header + lines.join("\n"));
});

app.listen(PORT, async () => {
  await ensureQr();
  console.log(`✅ Web lista en: ${PUBLIC_URL}`);
  console.log(`✅ QR disponible en: ${PUBLIC_URL}/qr.png`);
});

// BORRAR PARTICIPANTE
app.get("/admin/delete", (req, res) => {
  if (String(req.query.token || "") !== ADMIN_TOKEN) {
    return res.status(401).send("No autorizado.");
  }

  const id = Number(req.query.id);
  if (!id) return res.send("Falta el ID");

  db.prepare("DELETE FROM entries WHERE id=?").run(id);
  res.send(`Participante ${id} eliminado ✅`);
});
