const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS salvos (id TEXT PRIMARY KEY, dados JSONB NOT NULL, criado_em TIMESTAMP DEFAULT NOW(), atualizado_em TIMESTAMP DEFAULT NOW())`);
    console.log('Banco de dados inicializado');
  } catch(e) { console.error('Erro banco:', e.message); }
}

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analisar', async (req, res) => {
  console.log('=== ANÁLISE RECEBIDA ===');
  const { dados, urlEdital } = req.body;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Chave de API não configurada' });

  try {
    let docParaAnalisar = null;

    if (urlEdital) {
      const m = urlEdital.match(/editais\/(\d+)\/(\d+)\/(\d+)/);
      if (m) {
        const arquivosUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${m[1]}/compras/${m[2]}/${m[3]}/arquivos`;
        const arquivosResp = await fetch(arquivosUrl);
        if (arquivosResp.ok) {
          const arquivos = await arquivosResp.json();
          console.log('Arquivos:', arquivos.length);

          const edital = arquivos.find(a =>
            a.titulo.toLowerCase().includes('edital') ||
            a.tipoDocumentoNome === 'Edital'
          ) || arquivos[0];

          if (edital) {
            const pdfResp = await fetch(edital.url);
            if (pdfResp.ok) {
              const buffer = await pdfResp.buffer();
              console.log('PDF:', edital.titulo, Math.round(buffer.length/1024)+'KB');
              docParaAnalisar = { data: buffer.toString('base64'), mediaType: 'application/pdf', nome: edital.titulo };
            }
          }
        }
      }
    }

    let messages;
    const prompt = `Você é especialista em licitações de obras públicas no Brasil com 15 anos de experiência.
Analise este documento e retorne SOMENTE este JSON válido, sem markdown, sem texto antes ou depois:
{"resumo":"2-3 frases sobre objeto local e orgao","infoJuridica":"amparo legal prazo vigencia garantia penalidades","infoTec":"tipo obra local prazo execucao documentos obrigatorios para habilitacao listados","volumes":"principais itens curva ABC com quantidades e valores expectativa receita por mes principais materiais"}`;

    if (docParaAnalisar) {
      messages = [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: docParaAnalisar.data } },
        { type: 'text', text: prompt }
      ]}];
    } else {
      messages = [{ role: 'user', content: prompt + '\n\nDADOS: ' + JSON.stringify(dados).substring(0, 2000) }];
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages })
    });

    const result = await resp.json();
    console.log('Claude tipo:', result.type);
    if (result.error) {
      console.error('Claude erro:', result.error.message);
      return res.status(500).json({ error: result.error.message });
    }

    const txt = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    console.log('Resposta raw (200 chars):', txt.substring(0, 200));

    let ai = {};
    try {
      ai = JSON.parse(txt);
    } catch(e) {
      const m2 = txt.match(/\{[\s\S]*\}/);
      if (m2) {
        try { ai = JSON.parse(m2[0]); } catch(e2) { console.log('Parse erro:', e2.message); }
      }
    }

    console.log('Campos extraídos:', Object.keys(ai));
    res.json(ai);

  } catch (e) {
    console.error('ERRO:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/salvos', async (req, res) => {
  try {
    const result = await pool.query('SELECT dados FROM salvos ORDER BY atualizado_em DESC');
    res.json(result.rows.map(r => r.dados));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/salvos', async (req, res) => {
  const { id, dados } = req.body;
  if (!id || !dados) return res.status(400).json({ error: 'Dados inválidos' });
  try {
    await pool.query(`INSERT INTO salvos (id, dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET dados = $2, atualizado_em = NOW()`, [id, dados]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/salvos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM salvos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true }));

initDB().then(() => app.listen(PORT, () => console.log(`Licitrack backend rodando na porta ${PORT}`)));
