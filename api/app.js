const express = require("express");
const cors = require("cors");
const { Client } = require("pg");
const multer = require("multer");
const crypto = require("crypto");
const { Client: MinioClient } = require("minio");

const app = express();
app.use(cors());
app.use(express.json());

// ===== PostgreSQL =====
const pgClient = new Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

// ===== MinIO =====
const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT,
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

const BUCKET = process.env.MINIO_BUCKET || "user-photo";

// ===== Multer (upload) =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").toLowerCase());
}

function makeObjectName(originalName = "photo") {
  const ext = (originalName.includes(".") ? originalName.split(".").pop() : "jpg").toLowerCase();
  const id = crypto.randomBytes(16).toString("hex");
  return `${id}.${ext}`;
}

function publicObjectUrl(objectName) {
  // untuk rubrik: link foto dari MinIO
  // Akses via host:9000/bucket/object (akan bekerja jika bucket dibuat public / lewat presigned)
  return `http://localhost:9000/${BUCKET}/${objectName}`;
}

async function ensureBucket() {
  const exists = await minio.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await minio.makeBucket(BUCKET);
    console.log("MinIO bucket created:", BUCKET);
  } else {
    console.log("MinIO bucket exists:", BUCKET);
  }
}

async function initDb() {
  await pgClient.connect();
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      photo_url TEXT,
      photo_object TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("PostgreSQL connected + table ensured");
}

// ===== Routes =====
app.get("/health", async (req, res) => {
  try {
    await pgClient.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// READ all
app.get("/users", async (req, res) => {
  const r = await pgClient.query("SELECT * FROM users ORDER BY id DESC");
  res.json(r.rows);
});

// READ one
app.get("/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  const r = await pgClient.query("SELECT * FROM users WHERE id=$1", [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "User not found" });
  res.json(r.rows[0]);
});

// CREATE (multipart: name, email, photo)
app.post("/users", upload.single("photo"), async (req, res) => {
  try {
    const { name, email } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: "name & email required" });
    if (!isValidEmail(email)) return res.status(400).json({ error: "email invalid" });

    let photo_url = null;
    let photo_object = null;

    if (req.file) {
      // basic mimetype check
      if (!String(req.file.mimetype || "").startsWith("image/")) {
        return res.status(400).json({ error: "photo must be an image" });
      }

      photo_object = makeObjectName(req.file.originalname);
      await minio.putObject(BUCKET, photo_object, req.file.buffer, {
        "Content-Type": req.file.mimetype,
      });
      photo_url = publicObjectUrl(photo_object);
    }

    const r = await pgClient.query(
      "INSERT INTO users(name,email,photo_url,photo_object) VALUES($1,$2,$3,$4) RETURNING *",
      [name, email, photo_url, photo_object]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    // multer file too large
    if (e && e.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "photo max 5MB" });
    }
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// UPDATE (multipart optional: name, email, photo)
app.put("/users/:id", upload.single("photo"), async (req, res) => {
  try {
    const id = Number(req.params.id);

    const existing = await pgClient.query("SELECT * FROM users WHERE id=$1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "User not found" });

    const current = existing.rows[0];
    const name = (req.body && req.body.name) ? req.body.name : current.name;
    const email = (req.body && req.body.email) ? req.body.email : current.email;

    if (!name || !email) return res.status(400).json({ error: "name & email required" });
    if (!isValidEmail(email)) return res.status(400).json({ error: "email invalid" });

    let photo_url = current.photo_url;
    let photo_object = current.photo_object;

    // if new photo uploaded: delete old object + upload new
    if (req.file) {
      if (!String(req.file.mimetype || "").startsWith("image/")) {
        return res.status(400).json({ error: "photo must be an image" });
      }

      if (photo_object) {
        await minio.removeObject(BUCKET, photo_object).catch(() => {});
      }

      photo_object = makeObjectName(req.file.originalname);
      await minio.putObject(BUCKET, photo_object, req.file.buffer, {
        "Content-Type": req.file.mimetype,
      });
      photo_url = publicObjectUrl(photo_object);
    }

    const r = await pgClient.query(
      "UPDATE users SET name=$1, email=$2, photo_url=$3, photo_object=$4 WHERE id=$5 RETURNING *",
      [name, email, photo_url, photo_object, id]
    );

    res.json(r.rows[0]);
  } catch (e) {
    if (e && e.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "photo max 5MB" });
    }
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// DELETE (hapus postgres + hapus file MinIO)
app.delete("/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await pgClient.query("SELECT * FROM users WHERE id=$1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "User not found" });

    const { photo_object } = existing.rows[0];
    if (photo_object) {
      await minio.removeObject(BUCKET, photo_object).catch(() => {});
    }

    await pgClient.query("DELETE FROM users WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

const PORT = 8080;

(async () => {
  try {
    await initDb();
    await ensureBucket();
    app.listen(PORT, "0.0.0.0", () => console.log(`API running on :${PORT}`));
  } catch (e) {
    console.error("Init failed:", e);
    process.exit(1);
  }
})();
