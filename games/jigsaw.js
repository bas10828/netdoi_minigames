const jwt = require('jsonwebtoken');

const DIFF_BASE = { easy: 500, medium: 1000, hard: 2000 };
function calcScore(difficulty, time_sec) {
  return Math.max(10, Math.floor((DIFF_BASE[difficulty] || 500) * 60 / time_sec));
}

module.exports = function(app, pool, JWT_SECRET) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS jigsaw_scores (
      id SERIAL PRIMARY KEY,
      username VARCHAR(20) NOT NULL,
      image VARCHAR(50) NOT NULL,
      difficulty VARCHAR(10) NOT NULL,
      time_sec INTEGER NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() =>
    pool.query(`ALTER TABLE jigsaw_scores ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0`)
  ).catch(e => console.error('jigsaw table init:', e));

  app.post('/api/jigsaw/score', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const { username } = jwt.verify(token, JWT_SECRET);
      const { image, difficulty, time_sec } = req.body;
      if (!image || !['easy','medium','hard'].includes(difficulty) || !Number.isInteger(time_sec) || time_sec < 1)
        return res.status(400).json({ error: 'invalid' });
      const score = calcScore(difficulty, time_sec);
      await pool.query(
        'INSERT INTO jigsaw_scores (username,image,difficulty,time_sec,score) VALUES ($1,$2,$3,$4,$5)',
        [username, image, difficulty, time_sec, score]
      );
      res.json({ ok: true, score });
    } catch { res.status(401).json({ error: 'unauthorized' }); }
  });

  app.get('/api/jigsaw/leaderboard', async (req, res) => {
    const { image, difficulty } = req.query;
    if (!image || !difficulty) return res.status(400).json({ error: 'invalid' });
    const token = req.headers.authorization?.split(' ')[1];
    let me = null;
    if (token) { try { me = jwt.verify(token, JWT_SECRET).username; } catch {} }
    try {
      const { rows: top10 } = await pool.query(`
        SELECT username, MAX(score) AS best_score, MIN(time_sec) AS best_time
        FROM jigsaw_scores WHERE image=$1 AND difficulty=$2
        GROUP BY username ORDER BY best_score DESC, best_time ASC LIMIT 10
      `, [image, difficulty]);
      let myBest = null, myRank = null;
      if (me) {
        const { rows: mr } = await pool.query(
          'SELECT MAX(score) AS best_score FROM jigsaw_scores WHERE username=$1 AND image=$2 AND difficulty=$3',
          [me, image, difficulty]
        );
        myBest = mr[0]?.best_score != null ? parseInt(mr[0].best_score) : null;
        if (myBest !== null) {
          const { rows: rr } = await pool.query(`
            SELECT COUNT(*)+1 AS rank FROM (
              SELECT username, MAX(score) AS best_score FROM jigsaw_scores
              WHERE image=$1 AND difficulty=$2 GROUP BY username HAVING MAX(score)>$3
            ) s
          `, [image, difficulty, myBest]);
          myRank = parseInt(rr[0].rank);
        }
      }
      res.json({
        top10: top10.map(r => ({ username: r.username, best_score: parseInt(r.best_score), best_time: parseInt(r.best_time) })),
        me, myBest, myRank,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
  });

  app.get('/api/jigsaw/progress', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ cleared: [] });
    try {
      const { username } = jwt.verify(token, JWT_SECRET);
      const { rows } = await pool.query(
        'SELECT DISTINCT image, difficulty FROM jigsaw_scores WHERE username=$1',
        [username]
      );
      res.json({ cleared: rows.map(r => `${r.image}:${r.difficulty}`) });
    } catch { res.json({ cleared: [] }); }
  });

  app.get('/api/jigsaw/stats', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    let me = null;
    if (token) { try { me = jwt.verify(token, JWT_SECRET).username; } catch {} }
    try {
      const { rows } = await pool.query(`
        SELECT username,
               SUM(best_score)      AS total_score,
               COUNT(*)             AS levels_cleared,
               SUM(plays)           AS total_plays
        FROM (
          SELECT username, image, difficulty,
                 MAX(score)  AS best_score,
                 COUNT(*)    AS plays
          FROM jigsaw_scores
          GROUP BY username, image, difficulty
        ) sub
        GROUP BY username
        ORDER BY total_score DESC
        LIMIT 10
      `);
      res.json({
        top10: rows.map(r => ({
          username:       r.username,
          total_score:    parseInt(r.total_score),
          levels_cleared: parseInt(r.levels_cleared),
          total_plays:    parseInt(r.total_plays),
        })),
        me,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
  });
};
