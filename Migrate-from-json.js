// One-time migration: reads the old flat-file data.json and inserts
// its contents into Postgres. Run once, then retire data.json.
//
// Usage: DATABASE_URL=postgres://... node db/migrate-from-json.js
//
// IMPORTANT: I don't have your actual data.json in front of me, so this
// assumes a shape like:
//   { users: { "<id>": { auth: { email, salt, hash }, profile: {},
//                          savedJobs: [...], applications: [...] } } }
// Adjust the field paths below (raw.users, user.auth, user.savedJobs,
// user.applications) to match your real structure before running this.

const fs = require('fs');
const path = require('path');
const pool = require('./Pool');

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

    for (const oldId of userIds) {
        const user = users[oldId];

        if (!user.auth || !user.auth.email) {
            console.warn(`Skipping user ${oldId}: missing auth data`);
            continue;
        }

        const { rows } = await pool.query(
            `INSERT INTO users (email, salt, hash, profile)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`, [user.auth.email, user.auth.salt, user.auth.hash, JSON.stringify(user.profile || {})]
        );

        const newUserId = rows[0] && rows[0].id;
        if (!newUserId) {
            console.warn(`User ${user.auth.email} already exists in Postgres — skipping related data.`);
            continue;
        }

        for (const job of user.savedJobs || []) {
            await pool.query(
                `INSERT INTO saved_jobs (user_id, job_id, job_data)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [newUserId, job.id, JSON.stringify(job)]
            );
        }

        for (const app of user.applications || []) {
            await pool.query(
                `INSERT INTO applications (user_id, job_id, job_data, status)
         VALUES ($1, $2, $3, $4)`, [newUserId, app.jobId || app.id, JSON.stringify(app), app.status || 'applied']
            );
        }

        console.log(`Migrated ${user.auth.email}`);
    }

    console.log('Migration complete.');
    await pool.end();
}

migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});