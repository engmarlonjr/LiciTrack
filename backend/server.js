const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

app.post('/api/analisar', async (req, res) => {
  const { dados, documentos } = req.body;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Chave de API não configurada' });

  const promptSemDoc = `Você é especialista em licitações de obras públicas no Brasil com 15 anos de experiência.
Analise os dados desta licitação e retorne SOMENTE JSON puro sem markdown:
{
  "resumo": "2-3 frases objetivas sobre o objeto da licitação, local e órgão contratante",
  "infoTec": "• Tipo de obra/serviço: X\\n• Local de execução: X\\n• Prazo de execução: X\\n• Regime de execução: X\\n• Documentos obrigatórios para habilitação:\\n  - Certidão de registro no CREA/CAU\\n  - Atestado de capacidade técnica\\n  - Balanço patrimonial\\n  - [demais conforme edital]",
  "volumes": "• Principais serviços (curva ABC estimada):\\n  - [item principal] - maior peso\\n• Expectativa de receita/mês: R$ X (valor total ÷ prazo)\\n• Principais materiais: consulte planilha orçamentária no edital"
}
DADOS: ` + JSON.stringify(dados).substring(0, 3000);

  const promptComDoc = `Você é especialista em licitações de obras públicas no Brasil com 15 anos de experiência.
Analise este documento de licitação e retorne SOMENTE JSON puro sem markdown:
{
  "resumo": "2-3 frases objetivas sobre o objeto, local e órgão contratante",
  "infoJuridica": "• Amparo legal: X\\n• Prazo de vigência do contrato: X\\n• Garantia contratual: X\\n• Multas e penalidades: X\\n• Critério de julgamento: X",
  "infoTec": "• Tipo de obra/serviço: X\\n• Local de execução: X\\n• Prazo de execução: X meses\\n• Regime de execução: X\\n• Documentos obrigatórios para entrega/habilitação:\\n  - [liste cada documento exigido no edital]",
  "volumes": "• Principais itens por peso (curva ABC):\\n  - [item 1] — qtd X unid — R$ X\\n  - [item 2] — qtd X unid — R$ X\\n  - [item 3] — qtd X unid — R$ X\\n• Valor total estimado: R$ X\\n• Expectativa de receita/mês: R$ X (total ÷ prazo em meses)\\n• Principais materiais e insumos: [liste os mais relevantes com volumes]"
}`;

  try {
    let messages;

    if (documentos && documentos.length > 0) {
      // Analisa cada documento separadamente e consolida
      let consolidado = { resumo: '', infoJuridica: '', infoTec: '', volumes: '' };

      for (const doc of documentos) {
        const content = [
          {
            type: 'document',
            source: { type: 'base64', media_type: doc.mediaType, data: doc.data }
          },
          { type: 'text', text: promptComDoc + '\n\nDADOS DO PROCESSO (contexto adicional): ' + JSON.stringify(dados).substring(0, 1000) }
        ];

        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            messages: [{ role: 'user', content }]
          })
        });

        const result = await resp.json();
        if (result.error) continue;

        const txt = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
        let ai = {};
        try { ai = JSON.parse(txt); } catch(e) {
          const m2 = txt.match(/\{[\s\S]*\}/);
          if (m2) try { ai = JSON.parse(m2[0]); } catch(e2) {}
        }

        if (ai.resumo)       consolidado.resumo       = ai.resumo;
        if (ai.infoJuridica) consolidado.infoJuridica = (consolidado.infoJuridica ? consolidado.infoJuridica + '\n\n' : '') + ai.infoJuridica;
        if (ai.infoTec)      consolidado.infoTec      = (consolidado.infoTec ? consolidado.infoTec + '\n\n' : '') + ai.infoTec;
        if (ai.volumes)      consolidado.volumes      = (consolidado.volumes ? consolidado.volumes + '\n\n' : '') + ai.volumes;
      }

      return res.json(consolidado);

    } else {
      // Sem documentos — usa dados do PNCP
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          messages: [{ role: 'user', content: promptSemDoc }]
        })
      });

      const result = await resp.json();
      if (result.error) return res.status(500).json({ error: result.error.message });

      const txt = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      let ai = {};
      try { ai = JSON.parse(txt); } catch(e) {
        const m2 = txt.match(/\{[\s\S]*\}/);
        if (m2) try { ai = JSON.parse(m2[0]); } catch(e2) {}
      }

      return res.json(ai);
    }

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/salvos', async (req, res) => {
  try {
    const result = await pool.query('SELECT dados FROM salvos ORDER BY atualizado_em DESC');
    res.json(result.rows.map(r => r.dados));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
