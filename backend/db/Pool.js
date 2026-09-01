const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    console.warn('[db] DATABASE_URL is not set — Postgres connections will fail.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ?
        false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
    console.error('Unexpected Postgres pool error:', err);
});

module.exports = pool;