// Data access layer for Bluprint. This replaces the old flat-file
// data.json reads/writes — route handlers should call these functions
// instead of touching the file system directly.

const pool = require('./Pool');

function toProfile(row) {
    return row.profile || {};
}

// ----Users ---------------------------------------
async function findUserByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
}

async function findUserById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
}

async function createUser({ id, email, passwordSalt, passwordHash, profile }) {
    const { rows } = await pool.query(
        `INSERT INTO users (id, email, password_salt, password_hash, profile)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, email, passwordSalt, passwordHash, JSON.stringify(profile)]
    );
    return rows[0];
}

async function updateProfile(userId, profile) {
    const { rows } = await pool.query(
        'UPDATE users SET profile = $2 WHERE id = $1 RETURNING *', [userId, JSON.stringify(profile)]
    );
    return rows[0];
}
//--------- Saved Jobs ---------------------------------------
async function saveJob(userId, jobId, jobData) {
    const { rows } = await pool.query(
        `INSERT INTO saved_jobs (user_id, job_id, job_data)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, job_id) DO NOTHING
     RETURNING *`, [userId, jobId, jobData]
    );
    return rows[0] || null;
}

async function unsaveJob(userId, jobId) {
    await pool.query('DELETE FROM saved_jobs WHERE user_id = $1 AND job_id = $2', [
        userId,
        jobId,
    ]);
}

async function getSavedJobIds(userId) {
    const { rows } = await pool.query(
        'SELECT job_id FROM saved_jobs WHERE user_id = $1 ORDER BY saved_at DESC', [userId]
    );
    return rows.map((r) => r.job_id);
}

async function createApplication(userId, jobId, jobData) {
    const { rows } = await pool.query(
        `INSERT INTO applications (user_id, job_id, job_data)
     VALUES ($1, $2, $3) RETURNING *`, [userId, jobId, jobData]
    );
    return rows[0];
}

async function getApplications(userId) {
    const { rows } = await pool.query(
        'SELECT * FROM applications WHERE user_id = $1 ORDER BY applied_at DESC', [userId]
    );
    return rows;
}

async function createJobAlert(userId, criteria) {
    const { rows } = await pool.query(
        'INSERT INTO job_alerts (user_id, criteria) VALUES ($1, $2) RETURNING *', [userId, JSON.stringify(criteria)]
    );
    return rows[0];
}

async function getJobAlerts(userId) {
    const { rows } = await pool.query(
        'SELECT * FROM job_alerts WHERE user_id = $1 AND active = true', [userId]
    );
    return rows;
}

module.exports = {
    findUserByEmail,
    findUserById,
    createUser,
    updateProfile,
    saveJob,
    unsaveJob,
    getSavedJobs,
    createApplication,
    getApplications,
    createJobAlert,
    getJobAlerts,
};