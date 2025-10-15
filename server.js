import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

// Load projects dataset
const dataDir = path.join(__dirname, 'data');
const projectsPath = path.join(dataDir, 'projects.json');
let projects = [];
try {
  projects = JSON.parse(fs.readFileSync(projectsPath, 'utf-8'));
} catch (e) {
  console.warn('No se pudo leer data/projects.json, usando arreglo vacío.');
  projects = [];
}

// Basic keyword scoring for retrieval
function scoreProject(query, project) {
  const q = (query || '').toLowerCase();
  const fields = [project.name, project.description, project.status, (project.responsible||{}).name, ...(project.tags||[]), ...(project.documents||[]).map(d=>d.title)];
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  let score = 0;
  for (const term of q.split(/\s+/)) {
    if (!term) continue;
    const occur = (text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    score += occur;
  }
  // small bonus if exact project name mentioned
  if (project.name && q.includes(project.name.toLowerCase())) score += 3;
  return score;
}

function getTopContext(query, k = 3) {
  const ranked = projects
    .map(p => ({ p, s: scoreProject(query, p) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ p }) => p);
  return ranked;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/projects', (_req, res) => {
  res.json({ projects });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Mensaje inválido' });
    }

    const contextProjects = getTopContext(message, 4);

    // Build context summary to minimize tokens
    const projectSnippets = contextProjects.map((p, i) => `#${i+1} ${p.name}\nEstado: ${p.status}\nAvance: ${p.progress || 'N/D'}%\nResponsable: ${(p.responsible&&p.responsible.name)||'N/D'}\nÚltima actualización: ${p.lastUpdate || 'N/D'}\nDocumentos: ${(p.documents||[]).map(d=>d.title).join(', ') || '—'}\nDescripción: ${p.description}`).join('\n\n');

    const system = `Eres un asistente de COTRAFA SOCIAL. Responde en español, de forma concisa y útil. Si la pregunta no está clara, pide aclaración breve. Usa el siguiente contexto de proyectos solo si es relevante. Nunca inventes datos fuera del contexto y si no aparece, dilo. Si procede, incluye un mini resumen con Estado, Responsable y Última actualización.`;

    // If no key, return graceful info
    if (!OPENAI_API_KEY) {
      const top = contextProjects[0];
      const reply = top ? `Según el contexto, el proyecto "+${top.name}+" está "${top.status}". Responsable: ${(top.responsible&&top.responsible.name)||'N/D'}. Última actualización: ${top.lastUpdate||'N/D'}.` : 'No hay datos locales para responder.';
      return res.status(200).json({ reply, kpis: top ? { status: top.status, progress: top.progress, docs: (top.documents||[]).length, lastUpdate: top.lastUpdate } : null, usedModel: 'local-fallback' });
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Pregunta: ${message}\n\nContexto de proyectos:\n${projectSnippets || '—'}` }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.2,
      max_tokens: 300
    });

    const text = completion.choices?.[0]?.message?.content?.trim() || 'No pude generar una respuesta.';

    const top = contextProjects[0];
    const kpis = top ? { status: top.status, progress: top.progress, docs: (top.documents||[]).length, lastUpdate: top.lastUpdate } : null;

    res.json({ reply: text, kpis, usedModel: 'gpt-4o-mini' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fallo interno de chat' });
  }
});

// Serve static index.html and assets from workspace root
app.use(express.static(__dirname, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`COTRAFA SOCIAL app listening on http://localhost:${PORT}`);
});
