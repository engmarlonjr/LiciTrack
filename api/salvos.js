const { setCors } = require('./_cors');
const { getPool, initDB } = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  await initDB();
  const pool = getPool();

  if (req.method === 'GET') {
    try {
      const result = await pool.query('SELECT dados FROM salvos ORDER BY atualizado_em DESC');
      res.json(result.rows.map(r => r.dados));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  if (req.method === 'POST') {
    const { id, dados } = req.body;
    console.log('POST /api/salvos - id:', id ? id.substring(0, 20) : 'AUSENTE', '| dados:', dados ? 'presente' : 'AUSENTE');
    if (!id || !dados) return res.status(400).json({ error: 'Dados inválidos' });
    try {
      await pool.query(
        `INSERT INTO salvos (id, dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET dados = $2, atualizado_em = NOW()`,
        [id, dados]
      );
      console.log('Salvo com sucesso:', id.substring(0, 20));
      res.json({ ok: true });
    } catch (e) {
      console.error('Erro ao salvar no banco:', e.message);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Método não permitido' });
};
