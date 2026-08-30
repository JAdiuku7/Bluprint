// Postgres-backed replacement for the old data.json helpers
// (loadDb / saveDb / getUser). Every function here touches only the
// rows it needs, instead of reading and rewriting one giant file.

const pool = require('./Pool');

function toProfile(row) {
    return row.profile || {};
}

// ---- Users -------------------------------------------------------
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

// ---- Saved jobs ----------------------------------------------------
async function getSavedJobIds(userId) {
    const { rows } = await pool.query(
        'SELECT job_id FROM saved_jobs WHERE user_id = $1 ORDER BY saved_at DESC', [userId]
    );
    return rows.map((r) => r.job_id);
}

async function addSavedJob(userId, jobId) {
    await pool.query(
        `INSERT INTO saved_jobs (user_id, job_id) VALUES ($1, $2)
     ON CONFLICT (user_id, job_id) DO NOTHING`, [userId, jobId]
    );
}

async function removeSavedJob(userId, jobId) {
    await pool.query('DELETE FROM saved_jobs WHERE user_id = $1 AND job_id = $2', [userId, jobId]);
}

// ---- Alerts ----------------------------------------------------
function alertRowToJson(row) {
    return { id: row.id, name: row.name, query: row.query, createdAt: row.created_at.toISOString() };
}

async function getAlerts(userId) {
    const { rows } = await pool.query(
        'SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC', [userId]
    );
    return rows.map(alertRowToJson);
}

async function addAlert(userId, alert) {
    await pool.query(
        'INSERT INTO alerts (id, user_id, name, query, created_at) VALUES ($1, $2, $3, $4, $5)', [alert.id, userId, alert.name, JSON.stringify(alert.query), alert.createdAt]
    );
}

async function removeAlert(userId, alertId) {
    await pool.query('DELETE FROM alerts WHERE user_id = $1 AND id = $2', [userId, alertId]);
}

// ---- Applications ----------------------------------------------------
function applicationRowToJson(row) {
    return {
        ref: row.ref,
        jobId: row.job_id,
        jobTitle: row.job_title,
        company: row.company,
        submitted: row.submitted.toISOString(),
        name: row.name,
        email: row.email,
        phone: row.phone,
        link: row.link,
        note: row.note,
    };
}

async function getApplications(userId) {
    const { rows } = await pool.query(
        'SELECT * FROM applications WHERE user_id = $1 ORDER BY submitted DESC', [userId]
    );
    return rows.map(applicationRowToJson);
}

async function addApplication(userId, record) {
    await pool.query(
        `INSERT INTO applications
      (ref, user_id, job_id, job_title, company, submitted, name, email, phone, link, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
            record.ref,
            userId,
            record.jobId,
            record.jobTitle,
            record.company,
            record.submitted,
            record.name,
            record.email,
            record.phone,
            record.link,
            record.note,
        ]
    );
}

module.exports = {
    toProfile,
    findUserByEmail,
    findUserById,
    createUser,
    updateProfile,
    getSavedJobIds,
    addSavedJob,
    removeSavedJob,
    getAlerts,
    addAlert,
    removeAlert,
    getApplications,
    addApplication,
};