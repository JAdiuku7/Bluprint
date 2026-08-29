const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SECRET_FILE = path.join(__dirname, '..', '.session-secret');

function generateSecret() {
    if (process.env.SESSION_SECRET) {
        return process.env.SESSION_SECRET;
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('SESSION_SECRET environment variable must be set in production' +
            'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
        );
    }
    if (fs.existsSync(SECRET_FILE)) {
        return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    console.warn(
        '[auth] No session secret found, generated a new one and saved it to .session-secret. ' +
        'You should set the SESSION_SECRET environment variable in production to avoid this warning.'
    );
    return generated;
}

module.exports = { generateSecret };