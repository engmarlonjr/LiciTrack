const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Licitrack backend rodando na porta ${PORT}`));
