const admin = require('firebase-admin');
const fs = require('fs');

let serviceAccount = null;

const renderSecretPath = '/etc/secrets/service-account-key.json';
if (fs.existsSync(renderSecretPath)) {
  serviceAccount = JSON.parse(fs.readFileSync(renderSecretPath, 'utf8'));
  console.log('Using Render secret file');
} else {
  try {
    serviceAccount = require('../service-account-key.json');
    console.log('Using local service account file');
  } catch (e) {
    console.error('Could not find service account key');
  }
}

if (!admin.apps.length && serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'phronimos-learning',
  });
  console.log('Firebase Admin initialized');
}

const db = admin.firestore ? admin.firestore() : null;
const auth = admin.auth ? admin.auth() : null;

module.exports = { admin, db, auth };
