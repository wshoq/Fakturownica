// server.js (poprawiony)
// Zainstaluj zależności: npm i express multer axios form-data uuid sqlite3

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = 3011;

const upload = multer({ dest: 'uploads/' });
app.use(express.json());

// Ścieżki / konfiguracja
const DB_PATH = "/srv/Fakturownica/faktury.db";
const EXPORT_DIR = "/srv/Fakturownica/exports";
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

// webhook n8n (jak miałeś)
const webhookUrl = 'https://vps15151.awhost.cloud/webhook-test/fakturownica';

// axios instance (dla webhooków https z self-signed)
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

// prosty healthcheck
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ---- upload + job queue (jak wcześniej) ----
const jobs = {};
const waitingJobs = {};

async function convertAndSend(pdfPath, originalName, jobId) {
  return new Promise((resolve, reject) => {
    const outputDir = path.join(__dirname, 'OCRjpeg');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const baseName = `${Date.now()}-${originalName.replace(/\.pdf$/i, '')}`;
    const outputPath = path.join(outputDir, baseName);

    console.log(`🔄 Konwersja PDF → JPG: ${pdfPath}`);

    execFile('pdftoppm', ['-jpeg', pdfPath, outputPath], { cwd: __dirname }, async (err) => {
      if (err) return reject(err);

      const files = fs.readdirSync(outputDir)
        .filter(f => f.startsWith(baseName) && f.toLowerCase().endsWith('.jpg'));

      if (files.length === 0) return reject(new Error('Brak wygenerowanych plików JPG z PDF'));

      const formData = new FormData();
      formData.append('jobId', jobId);
      for (const fileName of files) {
        const jpgFilePath = path.join(outputDir, fileName);
        formData.append('file', fs.createReadStream(jpgFilePath));
      }

      try {
        await axiosInstance.post(webhookUrl, formData, { headers: formData.getHeaders() });

        // usuń pliki tymczasowe
        fs.unlink(pdfPath, () => {});
        for (const fileName of files) {
          const jpgFilePath = path.join(outputDir, fileName);
          fs.unlink(jpgFilePath, () => {});
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function processJobQueue(jobId) {
  const job = jobs[jobId];
  if (!job || job.processing) return;
  job.processing = true;
  while (job.queue.length > 0) {
    const file = job.queue.shift();
    try {
      await convertAndSend(file.path, file.originalname, jobId);
      job.completed++;
    } catch (e) {
      console.error('Błąd przetwarzania pliku:', e);
    }
  }
  job.processing = false;
  if (waitingJobs[jobId]) {
    waitingJobs[jobId]();
    delete waitingJobs[jobId];
  }
}

app.post('/api/upload', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Brak plików' });
  }
  const jobId = uuidv4();
  jobs[jobId] = {
    total: req.files.length,
    completed: 0,
    queue: req.files,
    processing: false
  };
  processJobQueue(jobId);
  res.json({ jobId, total: req.files.length });
});

app.get('/api/job-status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Nie znaleziono zadania' });
  res.json({ total: job.total, completed: job.completed });
});

// webhook potwierdzający (n8n -> backend)
app.post(['/webhook-test/fakturownica'], (req, res) => {
  const jobId = req.body.jobId;
  if (jobId && jobs[jobId]) jobs[jobId].completed++;
  res.json({ status: 'OK' });
});

// ---- Funkcje do odczytu/zapisu bazy ----
function readAllFactures() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
    });
    const q = `SELECT id, json_data FROM faktury ORDER BY id ASC`;
    db.all(q, [], (err, rows) => {
      db.close();
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// endpoint zwracający listę faktur (do frontendu)
app.get('/api/faktury', async (req, res) => {
  try {
    const rows = await readAllFactures();
    const list = rows.map(r => {
      let parsed = {};
      try { parsed = JSON.parse(r.json_data); } catch (e) { parsed = {}; }
      return {
        id: r.id,
        sprzedawca: parsed?.sprzedawca?.nazwa || "",
        nabywca: parsed?.nabywca?.nazwa || "",
        wartosc_brutto: parsed?.suma_brutto ?? parsed?.wartosc_brutto ?? 0,
        numer_faktury: parsed?.numer_faktury || ""
      };
    }).reverse();
    res.json(list);
  } catch (err) {
    console.error('Błąd odczytu faktur:', err);
    res.status(500).json({ error: 'Błąd odczytu faktur' });
  }
});

// endpoint generujący prosty XML i zwracający plik, po pobraniu czyści tabelę
app.get('/api/faktury/xml', async (req, res) => {
  try {
    const rows = await readAllFactures();
    if (!rows.length) return res.status(404).json({ error: 'Brak faktur do eksportu' });

    const invoices = rows.map(r => {
      let parsed = {};
      try { parsed = JSON.parse(r.json_data); } catch(e){ parsed = {}; }
      return {
        id: r.id,
        numer: parsed?.numer_faktury || "",
        sprzedawca: parsed?.sprzedawca?.nazwa || "",
        nabywca: parsed?.nabywca?.nazwa || "",
        suma_netto: parsed?.suma_netto || 0,
        suma_vat: parsed?.suma_vat || 0,
        suma_brutto: parsed?.suma_brutto || 0,
        raw: parsed
      };
    });

    // prosta heurystyka klasyfikacji
    const freq = {};
    invoices.forEach(inv => {
      if (inv.sprzedawca) freq[inv.sprzedawca] = (freq[inv.sprzedawca] || 0) + 1;
      if (inv.nabywca)   freq[inv.nabywca]   = (freq[inv.nabywca]   || 0) + 1;
    });
    const entries = Object.entries(freq).sort((a,b) => b[1]-a[1]);
    const mainEntity = entries.length ? entries[0][0] : null;

    // buduj XML
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Faktury>\n';
    for (const inv of invoices) {
      let typ = 'nieznany';
      if (mainEntity) {
        if (inv.sprzedawca === mainEntity) typ = 'sprzedaz';
        else if (inv.nabywca === mainEntity) typ = 'zakup';
      }
      xml += `  <Faktura id="${inv.id}" typ="${typ}">\n`;
      xml += `    <Numer>${escapeXml(inv.numer)}</Numer>\n`;
      xml += `    <Sprzedawca>${escapeXml(inv.sprzedawca)}</Sprzedawca>\n`;
      xml += `    <Nabywca>${escapeXml(inv.nabywca)}</Nabywca>\n`;
      xml += `    <Netto>${inv.suma_netto}</Netto>\n`;
      xml += `    <VAT>${inv.suma_vat}</VAT>\n`;
      xml += `    <Brutto>${inv.suma_brutto}</Brutto>\n`;
      xml += `  </Faktura>\n`;
    }
    xml += '</Faktury>\n';

    const fname = `faktury_export_${Date.now()}.xml`;
    const filePath = path.join(EXPORT_DIR, fname);
    fs.writeFileSync(filePath, xml, 'utf8');

    res.download(filePath, fname, (err) => {
      if (err) {
        console.error('Błąd przesyłania pliku:', err);
      } else {
        const db = new sqlite3.Database(DB_PATH);
        db.run('DELETE FROM faktury', [], function(delErr) {
          if (delErr) console.error('Błąd czyszczenia tabeli faktury:', delErr);
          db.close();
        });
      }
    });

  } catch (err) {
    console.error('Error generating XML:', err);
    res.status(500).json({ error: 'Błąd generowania XML' });
  }
});

function escapeXml(unsafe) {
  if (!unsafe && unsafe !== 0) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

app.listen(port, () => console.log(`🚀 Serwer działa na http://localhost:${port}`));
