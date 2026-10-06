// Entrypoint cho Google AI Studio / Cloud Run / App Engine
try { require('dotenv').config(); } catch (e) {}
require('./src/server.js');
