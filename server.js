/* eslint-disable no-console */
import express from "express";
import cors from "cors";
import pino from "pino";
import qrcode from "qrcode";
// import makeWASocket from "@whiskeysockets/baileys";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";


const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * In-memory session registry.
 * Persisted auth lives in ./auth/<sessionId>/ via useMultiFileAuthState.
 */
const sessions = new Map();
/**
 * sessions.get(sessionId) => {
 *   sock,
 *   status: "idle"|"connecting"|"qr_pending"|"connected"|"disconnected"|"error",
 *   lastQr: string|null,            // raw QR text
 *   lastQrDataUrl: string|null,     // PNG data URL
 *   config: { inboundUrl, inboundToken },
 *   me: { id, name }|null
 * }
 */

function nowIso() {
  return new Date().toISOString();
}

function ensureSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) {
    const init = {
      sock: null,
      status: "idle",
      lastQr: null,
      lastQrDataUrl: null,
      config: {
        inboundUrl: process.env.BACKEND_INBOUND_URL || null,
        inboundToken: process.env.BACKEND_INBOUND_TOKEN || null,
      },
      me: null,
      updatedAt: nowIso(),
    };
    sessions.set(sessionId, init);
    return init;
  }
  return s;
}

async function postWebhook({ sessionId, from, to, text, messageId, timestamp, contactName, raw }) {
  const s = sessions.get(sessionId);
  const inboundUrl = s?.config?.inboundUrl;
  const inboundToken = s?.config?.inboundToken;

  if (!inboundUrl || !inboundToken) {
    logger.warn({ sessionId }, "Webhook skipped: inboundUrl/inboundToken not configured");
    return;
  }

  const payload = {
    sessionId,
    from,
    to,
    text,
    timestamp,
    messageId,
    contactName,
    raw,
  };

  try {
    const resp = await fetch(inboundUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-baileys-token": inboundToken,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      logger.error({ sessionId, status: resp.status, body: t }, "Webhook forward failed");
    }
  } catch (e) {
    logger.error({ sessionId, err: String(e) }, "Webhook forward error");
  }
}

async function startSession(sessionId) {
  const s = ensureSession(sessionId);

  // if already connected, do nothing
  if (s.sock) return s;

  s.status = "connecting";
  s.updatedAt = nowIso();

  const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionId}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    // You can tune these based on your hosting:
    // connectTimeoutMs: 60_000,
    // defaultQueryTimeoutMs: 60_000,
    // keepAliveIntervalMs: 30_000,
    // syncFullHistory: false,
  });

  s.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      s.lastQr = qr;
      s.status = "qr_pending";
      s.updatedAt = nowIso();
      try {
        s.lastQrDataUrl = await qrcode.toDataURL(qr);
      } catch {
        s.lastQrDataUrl = null;
      }
    }

    if (connection === "open") {
      s.status = "connected";
      s.lastQr = null;
      s.lastQrDataUrl = null;
      s.me = sock.user ? { id: sock.user.id, name: sock.user.name } : null;
      s.updatedAt = nowIso();
      logger.info({ sessionId, me: s.me }, "Session connected");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.output?.payload?.error || lastDisconnect?.error?.message;

      s.status = "disconnected";
      s.updatedAt = nowIso();
      s.me = null;

      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ sessionId, code, reason }, "Session closed");

      // Clear socket reference
      s.sock = null;

      // Auto-reconnect unless logged out
      if (shouldReconnect) {
        setTimeout(() => startSession(sessionId).catch(() => {}), 1500);
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    // Only process notifications (incoming)
    if (m.type !== "notify") return;

    for (const msg of m.messages || []) {
      if (!msg.message) continue;
      if (msg.key?.fromMe) continue;

      const from = msg.key?.remoteJid || null;
      const messageId = msg.key?.id || null;
      const ts = msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
        : nowIso();

      // Extract text for common message types
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        null;

      // JID can be like "12345@s.whatsapp.net"
      const phone = from ? from.split("@")[0] : null;

      await postWebhook({
        sessionId,
        from: phone || from || "unknown",
        to: null,
        text: text || "",
        messageId,
        timestamp: ts,
        contactName: null,
        raw: msg,
      });
    }
  });

  return s;
}

function requireSessionId(req, res, next) {
  const sessionId = req.body?.sessionId || req.query?.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }
  req.sessionId = sessionId;
  next();
}

/**
 * Health
 */
app.get("/health", (_, res) => res.json({ ok: true, time: nowIso() }));

/**
 * List all sessions (in-memory)
 */
app.get("/api/sessions", (_, res) => {
  const items = Array.from(sessions.entries()).map(([id, s]) => ({
    sessionId: id,
    status: s.status,
    me: s.me,
    updatedAt: s.updatedAt,
    inboundUrlConfigured: !!s.config?.inboundUrl,
    inboundTokenConfigured: !!s.config?.inboundToken,
  }));
  res.json({ sessions: items });
});

/**
 * Configure a session's webhook forwarding (per device)
 */
app.post("/api/config", requireSessionId, (req, res) => {
  const { inboundUrl, inboundToken } = req.body || {};
  const s = ensureSession(req.sessionId);

  if (inboundUrl !== undefined) s.config.inboundUrl = inboundUrl;
  if (inboundToken !== undefined) s.config.inboundToken = inboundToken;
  s.updatedAt = nowIso();

  res.json({
    ok: true,
    sessionId: req.sessionId,
    config: {
      inboundUrlConfigured: !!s.config.inboundUrl,
      inboundTokenConfigured: !!s.config.inboundToken,
    },
  });
});

/**
 * Connect / start session (creates auth folder, begins QR flow)
 */
app.post("/api/connect", requireSessionId, async (req, res) => {
  try {
    // Optionally allow passing webhook config on connect
    const { inboundUrl, inboundToken } = req.body || {};
    const s = ensureSession(req.sessionId);
    if (inboundUrl) s.config.inboundUrl = inboundUrl;
    if (inboundToken) s.config.inboundToken = inboundToken;

    await startSession(req.sessionId);
    const cur = sessions.get(req.sessionId);

    res.json({
      ok: true,
      sessionId: req.sessionId,
      status: cur.status,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Disconnect (logout) a session
 */
app.post("/api/disconnect", requireSessionId, async (req, res) => {
  try {
    const s = sessions.get(req.sessionId);
    if (!s?.sock) return res.json({ ok: true, sessionId: req.sessionId, status: "disconnected" });

    await s.sock.logout();
    s.sock = null;
    s.status = "disconnected";
    s.updatedAt = nowIso();

    res.json({ ok: true, sessionId: req.sessionId, status: s.status });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Get QR for a session (raw string + image data URL)
 */
app.get("/api/qr", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: "Session not found" });

  res.json({
    sessionId,
    status: s.status,
    qr: s.lastQr,
    qrDataUrl: s.lastQrDataUrl,
    connected: s.status === "connected",
    phoneNumber: s.me?.id ? s.me.id.split(":")[0] : null,
    profileName: s.me?.name || null,
  });
});

/**
 * Get session status
 */
app.get("/api/status", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: "Session not found" });

  res.json({
    sessionId,
    status: s.status,
    me: s.me,
    updatedAt: s.updatedAt,
  });
});

/**
 * Send text message
 * body: { sessionId, phone, message }
 */
app.post("/api/send", requireSessionId, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message are required" });
  }

  try {
    const s = sessions.get(req.sessionId);
    if (!s?.sock) return res.status(400).json({ error: "Session not connected" });

    // Accept "12345" or full JID
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;

    const r = await s.sock.sendMessage(jid, { text: String(message) });

    res.json({
      ok: true,
      sessionId: req.sessionId,
      messageId: r?.key?.id || null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Send media (image/doc/audio/video) - optional endpoint if you want it now.
 * body: { sessionId, phone, type, url, caption?, filename? }
 */
app.post("/api/send-media", requireSessionId, async (req, res) => {
  const { phone, type, url, caption, filename } = req.body || {};
  if (!phone || !type || !url) {
    return res.status(400).json({ error: "phone, type, url are required" });
  }

  try {
    const s = sessions.get(req.sessionId);
    if (!s?.sock) return res.status(400).json({ error: "Session not connected" });

    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;

    // Baileys supports URL fetch internally for some media types.
    // If your host blocks outgoing fetch, you'll need to download to buffer first.
    let content = {};
    if (type === "image") content = { image: { url }, caption: caption || "" };
    else if (type === "video") content = { video: { url }, caption: caption || "" };
    else if (type === "audio") content = { audio: { url }, mimetype: "audio/mpeg" };
    else if (type === "document")
      content = { document: { url }, fileName: filename || "file", caption: caption || "" };
    else return res.status(400).json({ error: "type must be image|video|audio|document" });

    const r = await s.sock.sendMessage(jid, content);

    res.json({ ok: true, sessionId: req.sessionId, messageId: r?.key?.id || null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Baileys server listening on :${PORT}`);
});



