// npm i express multer axios form-data uuid sqlite3
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

const DB_PATH = "/srv/Fakturownica/faktury.db";
const EXPORT_DIR = "/srv/Fakturownica/exports";
const OCR_DIR = path.join(__dirname,'OCRjpeg');

if(!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR,{recursive:true});
if(!fs.existsSync(OCR_DIR)) fs.mkdirSync(OCR_DIR,{recursive:true});

const webhookUrl = 'https://vps15151.awhost.cloud/webhook/fakturownica';
const axiosInstance = axios.create({ 
  httpsAgent:new https.Agent({rejectUnauthorized:false}), 
  maxBodyLength:Infinity, 
  maxContentLength:Infinity 
});

// ---- Kolejka zadań ----
const jobs = {};

// konwersja PDF -> JPG i wysyłka do webhooka
async function convertAndSend(pdfPath, originalName, jobId){
  const baseName = `${Date.now()}-${originalName.replace(/\.pdf$/i,'')}`;
  const outputPath = path.join(OCR_DIR, baseName);

  return new Promise((resolve,reject)=>{
    execFile('pdftoppm',['-jpeg',pdfPath,outputPath],{cwd:__dirname}, async (err)=>{
      if(err) return reject(err);

      const files = fs.readdirSync(OCR_DIR).filter(f=>f.startsWith(baseName)&&f.toLowerCase().endsWith('.jpg'));
      if(files.length===0) return reject(new Error('Brak JPG z PDF'));

      const formData = new FormData();
      formData.append('jobId', jobId);
      files.forEach(f=>formData.append('file', fs.createReadStream(path.join(OCR_DIR,f))));

      try{
        // czekamy na webhook, zanim oznaczymy completed
        await axiosInstance.post(webhookUrl, formData, { headers: formData.getHeaders() });

        // oznacz plik jako przetworzony
        const job = jobs[jobId];
        if(job){
          job.completed++;
          job.queue.shift();
        }

        // usuń PDF
        fs.unlink(pdfPath,()=>{});
        // usuń JPG
        files.forEach(f=>fs.unlink(path.join(OCR_DIR,f),()=>{}));

        resolve();
      }catch(e){
        console.error('Błąd wysyłki do webhooka:', e.message);
        reject(e);
      }
    });
  });
}

// ---- kolejka zadań ----
function startJobQueue(jobId){
  const job = jobs[jobId];
  if(!job || job.processing) return;
  job.processing = true;

  async function next(){
    if(job.queue.length===0){ job.processing=false; return; }
    const file = job.queue[0];
    try{
      await convertAndSend(file.path, file.originalname, jobId);
      next();
    }catch(e){
      console.error('Błąd przetwarzania pliku:',e);
      job.queue.shift(); // pomiń plik
      next();
    }
  }

  next();
}

// ---- API ----
app.post('/api/upload', upload.array('files'), (req,res)=>{
  if(!req.files || req.files.length===0) return res.status(400).json({error:'Brak plików'});
  const jobId = uuidv4();
  jobs[jobId] = { total:req.files.length, completed:0, queue:[...req.files], processing:false };
  startJobQueue(jobId);
  res.json({ jobId, total:req.files.length });
});

app.get('/api/job-status/:jobId', (req,res)=>{
  const job = jobs[req.params.jobId];
  if(!job) return res.status(404).json({error:'Nie znaleziono zadania'});
  res.json({ total:job.total, completed:job.completed });
});

// ---- faktury ----
function readAllFactures(){ 
  return new Promise((resolve,reject)=>{
    const db=new sqlite3.Database(DB_PATH,sqlite3.OPEN_READONLY,(err)=>{ if(err) return reject(err); });
    db.all("SELECT id,json_data FROM faktury ORDER BY id ASC",[],(err,rows)=>{ db.close(); if(err) return reject(err); resolve(rows||[]); });
  }); 
}

app.get('/api/faktury', async(req,res)=>{
  try{
    const rows = await readAllFactures();
    const list = rows.map(r=>{
      let parsed={}; try{parsed=JSON.parse(r.json_data);}catch{}
      return {
        id:r.id,
        sprzedawca:parsed?.sprzedawca?.nazwa||"",
        nabywca:parsed?.nabywca?.nazwa||"",
        wartosc_brutto:parsed?.suma_brutto ?? 0,
        numer_faktury:parsed?.numer_faktury||""
      };
    }).reverse();
    res.json(list);
  }catch(e){console.error(e);res.status(500).json({error:'Błąd odczytu faktur'});}
});

// XML export
app.get('/api/faktury/xml', async(req,res)=>{
  try{
    const rows = await readAllFactures();
    if(!rows.length) return res.status(404).json({error:'Brak faktur do eksportu'});
    let xml='<?xml version="1.0" encoding="UTF-8"?>\n<Faktury>\n';
    rows.forEach(r=>{
      let parsed={}; try{parsed=JSON.parse(r.json_data);}catch{}
      xml+=`  <Faktura id="${r.id}">\n`;
      xml+=`    <Sprzedawca>${escapeXml(parsed?.sprzedawca?.nazwa)}</Sprzedawca>\n`;
      xml+=`    <Nabywca>${escapeXml(parsed?.nabywca?.nazwa)}</Nabywca>\n`;
      xml+=`    <Brutto>${parsed?.suma_brutto ?? 0}</Brutto>\n`;
      xml+=`  </Faktura>\n`;
    });
    xml+='</Faktury>\n';
    const fname=`faktury_export_${Date.now()}.xml`;
    const filePath=path.join(EXPORT_DIR,fname);
    fs.writeFileSync(filePath,xml,'utf8');
    res.download(filePath,fname,(err)=>{
      if(!err){
        const db=new sqlite3.Database(DB_PATH);
        db.run('DELETE FROM faktury',[],()=>{ db.close(); });
      }
    });
  }catch(e){console.error(e);res.status(500).json({error:'Błąd generowania XML'});}
});

function escapeXml(u){ if(!u&&u!==0)return''; return String(u).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }

app.listen(port,()=>console.log(`🚀 Serwer działa na http://localhost:${port}`));
