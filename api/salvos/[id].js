const { setCors } = require('../_cors');
const { getPool, initDB } = require('../_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Método não permitido' });

  await initDB();
  const pool = getPool();
  const { id } = req.query;

  try {
    await pool.query('DELETE FROM salvos WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
