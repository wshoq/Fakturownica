const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const app = express();
const port = 3011;

const upload = multer({ dest: 'uploads/' });
app.use(express.json());

const webhookUrl = 'https://vps15151.awhost.cloud/webhook-test/fakturownica';

const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

const jobs = {};
const waitingJobs = {};

async function convertAndSend(pdfPath, originalName, jobId) {
  return new Promise((resolve, reject) => {
    const outputDir = path.join(__dirname, 'OCRjpeg');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const baseName = `${Date.now()}-${originalName.replace(/\.pdf$/i, '')}`;
    const outputPath = path.join(outputDir, baseName);

    console.log(`🔄 Konwersja PDF → JPG: ${pdfPath}`);

    execFile('pdftoppm', ['-jpeg', '-f', '1', '-l', '1', pdfPath, outputPath], { cwd: __dirname }, async (err) => {
      if (err) return reject(err);

      const jpgFilePath = `${outputPath}-1.jpg`;
      if (!fs.existsSync(jpgFilePath)) return reject(new Error('Plik JPG nie został utworzony'));

      const formData = new FormData();
      formData.append('file', fs.createReadStream(jpgFilePath));
      formData.append('jobId', jobId);

      try {
        await axiosInstance.post(webhookUrl, formData, { headers: formData.getHeaders() });
        fs.unlink(pdfPath, () => {});
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
    try { await convertAndSend(file.path, file.originalname, jobId); } catch(e){ console.error(e); }
  }
  job.processing = false;
  if (waitingJobs[jobId]) { waitingJobs[jobId](); delete waitingJobs[jobId]; }
}

app.post('/api/upload', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Brak plików' });
  const jobId = uuidv4();
  jobs[jobId] = { total: req.files.length, completed: 0, queue: req.files, processing: false };
  processJobQueue(jobId);
  res.json({ jobId, total: req.files.length });
});

app.get('/api/job-status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Nie znaleziono zadania' });
  res.json({ total: job.total, completed: job.completed });
});

app.post(['/webhook-test/fakturownica'], (req, res) => {
  const jobId = req.body.jobId;
  if (jobId && jobs[jobId]) jobs[jobId].completed++;
  res.json({ status: 'OK' });
});

app.listen(port, () => console.log(`🚀 Serwer działa na http://localhost:${port}`));
