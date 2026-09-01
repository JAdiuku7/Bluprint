// One-time migration: reads the existing data.json and loads it into
// Postgres. Run once, then you can delete data.json and .session-secret's
// dependency on it goes away too (separate blocker).
//
// Usage: DATABASE_URL=postgres://... node db/migrate-from-json.js

const fs = require('fs');
const path = require('path');
const pool = require('./backend/db/Pool');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

async function migrate() {
    if (!fs.existsSync(DATA_FILE)) {
        console.log('No data.json found — nothing to migrate.');
        return;
    }

    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const users = raw.users || {};
    const userIds = Object.keys(users);

    console.log(`Found ${userIds.length} users to migrate.`);

    for (const userId of userIds) {
        const user = users[userId];

        if (!user.auth || !user.auth.email) {
            console.warn(`Skipping ${userId}: no auth data (never completed signup)`);
            continue;
        }

        const { rows } = await pool.query(
            `INSERT INTO users (id, email, password_salt, password_hash, profile)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`, [
                userId,
                user.auth.email,
                user.auth.passwordSalt,
                user.auth.passwordHash,
                JSON.stringify(user.profile || {}),
            ]
        );

        if (!rows[0]) {
            console.warn(`User ${user.auth.email} already exists in Postgres — skipping related data.`);
            continue;
        }

        for (const jobId of user.savedJobIds || []) {
            await pool.query(
                `INSERT INTO saved_jobs (user_id, job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, jobId]
            );
        }

        for (const alert of user.alerts || []) {
            await pool.query(
                `INSERT INTO alerts (id, user_id, name, query, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [alert.id, userId, alert.name, JSON.stringify(alert.query), alert.createdAt]
            );
        }

        for (const app of user.applications || []) {
            await pool.query(
                `INSERT INTO applications
          (ref, user_id, job_id, job_title, company, submitted, name, email, phone, link, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING`, [
                    app.ref,
                    userId,
                    app.jobId,
                    app.jobTitle,
                    app.company,
                    app.submitted,
                    app.name || '',
                    app.email || '',
                    app.phone || '',
                    app.link || '',
                    app.note || '',
                ]
            );
        }

        console.log(`Migrated ${user.auth.email} (${(user.savedJobIds || []).length} saved, ${(user.alerts || []).length} alerts, ${(user.applications || []).length} applications)`);
    }

    console.log('Migration complete.');
    await pool.end();
}

migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});