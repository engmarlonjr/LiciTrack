const { setCors } = require('./_cors');

module.exports = (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.json({ ok: true });
};
