const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── BANCO DE DADOS ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS salvos (
        id TEXT PRIMARY KEY,
        dados JSONB NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW(),
        atualizado_em TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Banco de dados inicializado');
  } catch(e) {
    console.error('Erro ao inicializar banco:', e.message);
  }
}

// ── BUSCA DADOS DO PNCP ──────────────────────────────────
app.get('/api/pncp', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL não informada' });
  try {
    const m = url.match(/editais\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) return res.status(400).json({ error: 'URL inválida' });
    const apiUrl = `https://pncp.gov.br/api/consulta/v1/orgaos/${m[1]}/compras/${m[2]}/${m[3]}`;
    const resp = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return res.status(resp.status).json({ error: 'PNCP indisponível' });
    const dados = await resp.json();
    res.json(dados);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANÁLISE COM CLAUDE ───────────────────────────────────
app.post('/api/analisar', async (req, res) => {
  const { dados, documentos } = req.body;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Chave de API não configurada' });
  try {
    let messages;
    if (documentos && documentos.length > 0) {
      const content = documentos.map(d => ({
        type: 'document',
        source: { type: 'base64', media_type: d.mediaType, data: d.data }
      }));
      content.push({ type: 'text', text: 'Analise esta licitação e seus documentos. Retorne SOMENTE JSON puro sem markdown:\n{"resumo":"2-3 frases sobre o projeto","infoJuridica":"prazo, habilitação, garantia, penalidades","infoTec":"tipo de obra, prazo execução, especificações","volumes":"principais itens com quantidades"}\n\nDADOS DO PROCESSO: ' + JSON.stringify(dados).substring(0, 2000) });
      messages = [{ role: 'user', content }];
    } else {
      messages = [{ role: 'user', content: 'Analise esta licitação. Retorne SOMENTE JSON puro sem markdown:\n{"resumo":"2-3 frases sobre o projeto","infoTec":"tipo de obra e local","volumes":"consulte o edital para quantitativos"}\n\nDADOS: ' + JSON.stringify(dados).substring(0, 2500) }];
    }
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages })
    });
    const result = await resp.json();
    if (result.error) return res.status(500).json({ error: result.error.message });
    const txt = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let ai = {};
    try { ai = JSON.parse(txt); } catch(e) { const m2 = txt.match(/\{[\s\S]*\}/); if (m2) try { ai = JSON.parse(m2[0]); } catch(e2) {} }
    res.json(ai);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SALVOS — LISTAR ──────────────────────────────────────
app.get('/api/salvos', async (req, res) => {
  try {
    const result = await pool.query('SELECT dados FROM salvos ORDER BY atualizado_em DESC');
    res.json(result.rows.map(r => r.dados));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SALVOS — ADICIONAR/ATUALIZAR ─────────────────────────
app.post('/api/salvos', async (req, res) => {
  const { id, dados } = req.body;
  if (!id || !dados) return res.status(400).json({ error: 'Dados inválidos' });
  try {
    await pool.query(`
      INSERT INTO salvos (id, dados, atualizado_em)
      VALUES ($1, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET dados = $2, atualizado_em = NOW()
    `, [id, dados]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SALVOS — REMOVER ─────────────────────────────────────
app.delete('/api/salvos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM salvos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

initDB().then(() => {
  app.listen(PORT, () => console.log(`Licitrack backend rodando na porta ${PORT}`));
});
