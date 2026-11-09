const { setCors } = require('./_cors');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_PDF = 5 * 1024 * 1024;

async function tentarBaixarPDF(arq) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const pdfResp = await fetch(arq.url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!pdfResp.ok) return null;
    const buffer = Buffer.from(await pdfResp.arrayBuffer());
    if (buffer.length > MAX_PDF) return null;
    return { data: buffer.toString('base64'), mediaType: 'application/pdf', nome: arq.titulo };
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

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
          const editais = arquivos.filter(a => a.titulo.toLowerCase().includes('edital') || a.tipoDocumentoNome === 'Edital');
          const outros = arquivos.filter(a => !a.titulo.toLowerCase().includes('edital') && a.tipoDocumentoNome !== 'Edital');

          const grupos = [editais.slice(0, 3), outros.slice(0, 3)];
          for (const grupo of grupos) {
            if (!grupo.length) continue;
            const resultados = await Promise.all(grupo.map(tentarBaixarPDF));
            const encontrado = resultados.find(r => r !== null);
            if (encontrado) { docParaAnalisar = encontrado; break; }
          }
        }
      }
    }

    const prompt = `Você é especialista em licitações de obras públicas no Brasil com 15 anos de experiência.
Analise este documento e retorne SOMENTE este JSON válido, sem markdown, sem texto antes ou depois:
{"resumo":"2-3 frases sobre objeto local e orgao","infoJuridica":"amparo legal prazo vigencia garantia penalidades","infoTec":"tipo obra local prazo execucao documentos obrigatorios para habilitacao listados","volumes":"principais itens curva ABC com quantidades e valores expectativa receita por mes principais materiais"}`;

    let messages;
    if (docParaAnalisar) {
      messages = [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: docParaAnalisar.data } },
        { type: 'text', text: prompt }
      ]}];
    } else {
      const dadosTxt = JSON.stringify(dados, null, 0);
      messages = [{ role: 'user', content: prompt + '\n\nDADOS: ' + dadosTxt.substring(0, 8000) }];
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25'
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages })
    });

    const result = await resp.json();
    if (result.error) return res.status(500).json({ error: result.error.message });

    const txt = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const stripped = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let ai = {};
    try {
      ai = JSON.parse(stripped);
    } catch (e) {
      const m2 = stripped.match(/\{[\s\S]*\}/);
      if (m2) {
        try { ai = JSON.parse(m2[0]); } catch (e2) { /* resposta inválida */ }
      }
    }

    res.json(ai);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
