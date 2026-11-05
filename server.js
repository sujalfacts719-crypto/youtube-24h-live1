const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" +
      file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_"));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith("video/"));
  }
});

app.use("/api", (req, res, next) => {
  if (!process.env.APP_PASSWORD ||
      req.headers["x-app-password"] !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  next();
});

let processLive = null;
let timer = null;
let startedAt = 0;
let lastError = "";
let runningFile = null;

const DURATION = 24 * 60 * 60 * 1000;

function cleanup() {
  if (timer) clearTimeout(timer);
  timer = null;
  processLive = null;
  startedAt = 0;
  runningFile = null;
}

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Select a valid video" });
  }
  res.json({ success: true, filename: req.file.filename });
});

app.post("/api/start", (req, res) => {
  if (processLive) {
    return res.status(409).json({ error: "Already running" });
  }

  const filename = path.basename(req.body.filename || "");
  const videoPath = path.join(uploadDir, filename);

  if (!filename || !fs.existsSync(videoPath)) {
    return res.status(400).json({ error: "Video not found" });
  }

  const key = process.env.YOUTUBE_STREAM_KEY;
  const base = process.env.YOUTUBE_RTMP_URL;

  if (!key || !base) {
    return res.status(500).json({ error: "YouTube settings missing" });
  }

  const args = [
    "-hide_banner", "-loglevel", "error",
    "-re", "-stream_loop", "-1",
    "-i", videoPath,
    "-t", "86400",
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-g", "60",
    "-b:v", "2500k",
    "-maxrate", "2500k",
    "-bufsize", "5000k",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-f", "flv",
    base.replace(/\/+$/, "") + "/" + key
  ];

  lastError = "";

  const child = spawn("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"]
  });

  processLive = child;
  startedAt = Date.now();
  runningFile = filename;

  child.stderr.on("data", data => {
    lastError = data.toString().slice(-1000);
  });

  child.on("error", error => {
    lastError = error.message;
    if (processLive === child) cleanup();
  });

  child.on("close", () => {
    if (processLive === child) cleanup();
  });

  timer = setTimeout(() => {
    if (processLive === child) child.kill("SIGTERM");
  }, DURATION);

  res.json({
    success: true,
    message: "Streaming process started"
  });
});

app.post("/api/stop", (req, res) => {
  if (!processLive) {
    return res.json({ message: "No live running" });
  }

  processLive.kill("SIGTERM");
  res.json({ message: "Stop command sent" });
});

app.get("/api/status", (req, res) => {
  const running = !!processLive;
  const elapsed = running ? Date.now() - startedAt : 0;

  res.json({
    running,
    filename: runningFile,
    remainingMs: running
      ? Math.max(0, DURATION - elapsed)
      : 0,
    error: lastError
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
})
