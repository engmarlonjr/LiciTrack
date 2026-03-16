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
  console.log('=== REQUISIÇÃO DE ANÁLISE RECEBIDA ===');
  const { dados, urlEdital } = req.body;
  console.log('urlEdital:', urlEdital);
  console.log('ANTHROPIC_KEY presente:', !!ANTHROPIC_KEY);

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Chave de API não configurada' });

  try {
    let docParaAnalisar = null;
    let docSecundario = null;

    if (urlEdital) {
      const m = urlEdital.match(/editais\/(\d+)\/(\d+)\/(\d+)/);
      if (m) {
        console.log('Buscando arquivos PNCP...');
        const arquivosUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${m[1]}/compras/${m[2]}/${m[3]}/arquivos`;
        const arquivosResp = await fetch(arquivosUrl);
        
        if (arquivosResp.ok) {
          const arquivos = await arquivosResp.json();
          console.log('Arquivos encontrados:', arquivos.length);
          
          // Procura edital principal
          const edital = arquivos.find(a => 
            a.titulo.toLowerCase().includes('edital') ||
            a.tipoDocumentoNome === 'Edital'
          );
          
          // Procura orçamento sintético
          const orcamento = arquivos.find(a => 
            a.titulo.toLowerCase().includes('sintetico') ||
            a.titulo.toLowerCase().includes('sintético') ||
            a.titulo.toLowerCase().includes('sintet') ||
            (a.titulo.toLowerCase().includes('orcamento') && a.titulo.toLowerCase().includes('sint'))
          );

          const selecionados = [edital, orcamento].filter(Boolean);
          console.log('Selecionados:', selecionados.map(a => a?.titulo));

          if (selecionados.length > 0) {
            const docsAnalisados = [];
            for (const arq of selecionados) {
              console.log('Baixando:', arq.titulo);
              const pdfResp = await fetch(arq.url);
              if (pdfResp.ok) {
                const buffer = await pdfResp.buffer();
                const ext = arq.titulo.split('.').pop().toLowerCase();
                const mediaType = ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                console.log('Baixado:', arq.titulo, Math.round(buffer.length/1024), 'KB');
                docsAnalisados.push({ data: buffer.toString('base64'), mediaType, nome: arq.titulo });
              }
            }
            if (docsAnalisados.length > 0) docParaAnalisar = docsAnalisados[0];
            if (docsAnalisados.length > 1) docSecundario = docsAnalisados[1];
          } else if (arquivos.length > 0) {
            // Fallback: pega o primeiro arquivo disponível
            const arq = arquivos[0];
            console.log('Fallback - baixando:', arq.titulo);
            const pdfResp = await fetch(arq.url);
            if (pdfResp.ok) {
              const buffer = await pdfResp.buffer();
              docParaAnalisar = { data: buffer.toString('base64'), mediaType: 'application/pdf', nome: arq.titulo };
            }
          }
        } else {
          console.log('Erro ao buscar arquivos:', arquivosResp.status);
        }
      }
    }

    let prompt, messages;

    if (docParaAnalisar) {
      console.log('Analisando com documento(s):', docParaAnalisar.nome, docSecundario?.nome || '');
      prompt = `Você é especialista em licitações de obras públicas no Brasil. Analise este(s) documento(s) e retorne SOMENTE JSON puro sem markdown:
{"resumo":"2-3 frases sobre o objeto, local e órgão","infoJuridica":"amparo legal, prazo vigência, garantia, penalidades","infoTec":"tipo obra, local, prazo execução, documentos obrigatórios para habilitação (liste cada um)","volumes":"principais itens curva ABC com qtd e valor, expectativa receita/mês, principais materiais"}
DADOS DO PROCESSO: ` + JSON.stringify(dados).substring(0, 500);
      const content = [
        { type: 'document', source: { type: 'base64', media_type: docParaAnalisar.mediaType, data: docParaAnalisar.data } }
      ];
      if (docSecundario) {
        content.push({ type: 'document', source: { type: 'base64', media_type: docSecundario.mediaType, data: docSecundario.data } });
      }
      content.push({ type: 'text', text: prompt });
      messages = [{ role: 'user', content }];
    } else {
      console.log('Analisando sem documento');
      prompt = `Analise esta licitação e retorne SOMENTE JSON puro: {"resumo":"2-3 frases","infoTec":"tipo obra, local, prazo, documentos obrigatórios estimados","volumes":"principais serviços estimados, receita/mês estimada"} DADOS: ` + JSON.stringify(dados).substring(0, 2000);
      messages = [{ role: 'user', content: prompt }];
    }

    console.log('Chamando Claude...');
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages })
    });

    const result = await resp.json();
    console.log('Claude status:', result.type, result.error?.message || 'OK');

    if (result.error) return res.status(500).json({ error: result.error.message });

    const txt = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let ai = {};
    try { ai = JSON.parse(txt); } catch(e) { const m2 = txt.match(/\{[\s\S]*\}/); if (m2) try { ai = JSON.parse(m2[0]); } catch(e2) {} }
    
    console.log('Análise concluída. Campos:', Object.keys(ai));
    res.json(ai);

  } catch (e) {
    console.error('ERRO GERAL:', e.message);
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
