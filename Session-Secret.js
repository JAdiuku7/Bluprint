const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SECRET_FILE = path.join(__dirname, '..', '.session-secret');