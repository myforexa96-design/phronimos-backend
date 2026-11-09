require('dotenv').config();
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ============================================================
// FIREBASE ADMIN INIT
// Order of preference:
//   1. FIREBASE_SERVICE_ACCOUNT env var (full JSON contents)
//   2. Secret file on Render (/etc/secrets/service-account-key.json)
//   3. GOOGLE_APPLICATION_CREDENTIALS path, if set
// The project ID is always read from inside the key itself, so a
// missing or malformed FIREBASE_PROJECT_ID can no longer break payments.
// ============================================================
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const candidates = [
    '/etc/secrets/service-account-key.json',
    (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim(),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  throw new Error(
    'No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT or add the secret file service-account-key.json on Render.'
  );
}

if (!admin.apps.length) {
  const sa = loadServiceAccount();
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: String(sa.project_id).trim(),
  });
  console.log('Firebase Admin ready for project:', String(sa.project_id).trim());
}
const db = admin.firestore();

// In-memory cache so repeated sentences load in < 5ms with zero CPU/network usage
const ttsCache = new Map();

// ============================================================
// MIDDLEWARES FOR AUTHENTICATION & SECURITY
// ============================================================
async function verifyUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.userId = decodedToken.uid;
    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

async function verifyAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const adminUserId = decodedToken.uid;

    const userDoc = await db.collection('users').doc(adminUserId).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const isAdminUser = userData.role === 'admin' || decodedToken.email === 'phronimosbusinesses@gmail.com';

    if (!isAdminUser) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    req.adminUserId = adminUserId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({ message: 'Phronimos API is running', status: 'ok' });
});

// ============================================================
// PAYMENT VERIFICATION (secure)
// - requires a logged-in student (uses the verified token, not a userId from the body)
// - checks currency and minimum amount with Paystack
// - checks the payment was made by this same account
// - each Paystack reference can only be redeemed once
// ============================================================
const MIN_AMOUNT_PESEWAS = 200; // GHS 2.00

async function activatePremium(reference, userId, { checkOwner }) {
  const r = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${(process.env.PAYSTACK_SECRET_KEY || '').trim()}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const body = await r.json();
  const tx = body.data;

  if (!body.status || !tx || tx.status !== 'success') {
    return { code: 400, error: 'Payment not successful' };
  }
  if (tx.currency !== 'GHS' || tx.amount < MIN_AMOUNT_PESEWAS) {
    return { code: 400, error: 'Payment amount too low' };
  }
  if (checkOwner) {
    const fields = (tx.metadata && tx.metadata.custom_fields) || [];
    const f = fields.find((x) => x.variable_name === 'user_id');
    if (!f || f.value !== userId) {
      return { code: 403, error: 'Payment belongs to another account' };
    }
  }

  const payRef = db.collection('payments').doc(reference);
  const userRef = db.collection('users').doc(userId);

  return db.runTransaction(async (t) => {
    const existing = await t.get(payRef);
    const userSnap = await t.get(userRef);

    if (!userSnap.exists) {
      return { code: 404, error: 'User not found' };
    }

    if (existing.exists) {
      if (existing.data().userId !== userId) {
        return { code: 409, error: 'Reference already used' };
      }
      // Same student retrying the same payment: succeed without extending again
      const exp = userSnap.data().subscription && userSnap.data().subscription.expiryTime;
      return { code: 200, expiryTime: exp ? exp.toMillis() : null };
    }

    const expiryTime = admin.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);

    t.update(userRef, {
      'subscription.hasPaid': true,
      'subscription.isActive': true,
      'subscription.purchaseTime': admin.firestore.FieldValue.serverTimestamp(),
      'subscription.expiryTime': expiryTime,
      'subscription.paymentReference': reference,
      'subscription.amountPaid': tx.amount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    t.set(payRef, {
      userId: userId,
      email: (tx.customer && tx.customer.email) || null,
      reference: reference,
      amount: tx.amount,
      currency: tx.currency,
      status: 'success',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { code: 200, expiryTime: expiryTime.toMillis() };
  });
}

app.post('/api/verify-payment', verifyUser, async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) {
      return res.status(400).json({ error: 'Missing reference' });
    }

    const out = await activatePremium(reference, req.userId, { checkOwner: true });
    if (out.code !== 200) {
      return res.status(out.code).json({ error: out.error });
    }

    res.json({
      success: true,
      message: 'Payment verified and subscription activated for 24 hours',
      expiryTime: out.expiryTime,
    });
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin only: restore access for students who paid while the backend was broken.
// POST /api/admin/recover-payment  { reference, userId }  (with admin Bearer token)
app.post('/api/admin/recover-payment', verifyAdmin, async (req, res) => {
  try {
    const { reference, userId } = req.body;
    if (!reference || !userId) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const out = await activatePremium(reference, userId, { checkOwner: false });
    if (out.code !== 200) {
      return res.status(out.code).json({ error: out.error });
    }
    res.json({ success: true, expiryTime: out.expiryTime });
  } catch (error) {
    console.error('Recover payment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// CHECK SUBSCRIPTION STATUS
// ============================================================
app.get('/api/subscription/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const subscription = userData.subscription || {};
    const now = Date.now();

    const isActive = subscription.hasPaid &&
                     subscription.expiryTime &&
                     subscription.expiryTime.toMillis() > now;

    res.json({
      hasPaid: subscription.hasPaid || false,
      isActive: isActive,
      expiryTime: subscription.expiryTime ? subscription.expiryTime.toMillis() : null,
      trialActive: userData.trial?.trialActive || false,
      trialExpiryTime: userData.trial?.trialEndTime ? userData.trial.trialEndTime.toMillis() : null
    });

  } catch (error) {
    console.error('Error checking subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// START 15-MINUTE TRIAL
// ============================================================
app.post('/api/start-trial', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const now = admin.firestore.Timestamp.now();

    // Check if already has active premium
    if (userData.subscription?.hasPaid && userData.subscription.expiryTime?.toMillis() > Date.now()) {
      return res.json({ success: true, message: 'Premium already active', trialActive: false });
    }

    // Check if trial available
    const lastReset = userData.trial?.lastTrialReset?.toMillis() || 0;
    const hoursSinceReset = (Date.now() - lastReset) / (1000 * 60 * 60);

    if (hoursSinceReset >= 24) {
      // New trial available
      const trialEndTime = admin.firestore.Timestamp.fromMillis(Date.now() + (15 * 60 * 1000));

      await db.collection('users').doc(userId).update({
        'trial.lastTrialReset': now,
        'trial.trialEndTime': trialEndTime,
        'trial.trialActive': true,
        'trial.trialUsedToday': true,
        'updatedAt': admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({ success: true, trialActive: true, trialExpiryTime: trialEndTime.toMillis() });
    } else if (userData.trial?.trialActive && userData.trial.trialEndTime?.toMillis() > Date.now()) {
      // Trial still active
      res.json({ success: true, trialActive: true, trialExpiryTime: userData.trial.trialEndTime.toMillis() });
    } else {
      // No trial available
      res.json({ success: false, trialActive: false, message: 'No trial available. Please upgrade.' });
    }

  } catch (error) {
    console.error('Error starting trial:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// SAVE PROGRESS (with subscription check)
// ============================================================
app.post('/api/save-progress', async (req, res) => {
  try {
    const { userId, progress } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    // Check if user has active premium
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    const hasActivePremium = userData.subscription?.hasPaid &&
                             userData.subscription.expiryTime?.toMillis() > Date.now();

    if (!hasActivePremium) {
      return res.status(403).json({ error: 'Premium subscription required to save progress' });
    }

    await db.collection('users').doc(userId).update({
      'progress': progress,
      'updatedAt': admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'Progress saved' });

  } catch (error) {
    console.error('Error saving progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// AI PROXY ENDPOINTS (Requires User Auth)
// ============================================================

// Groq Proxy
app.post('/api/ask-ai', verifyUser, async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens } = req.body;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'openai/gpt-oss-120b',
        messages: messages,
        temperature: temperature ?? 0.7,
        max_tokens: max_tokens ?? 1000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Groq API error', details: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Groq Proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Smallest.ai TTS Proxy
app.post('/api/synthesize-voice/smallest', verifyUser, async (req, res) => {
  try {
    const { text, voice_id } = req.body;

    const response = await fetch('https://waves.smallest.ai/api/v1/lightning', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SMALLEST_AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text,
        voice_id: voice_id || 'nyah',
        speed: 1.0,
        add_wav_header: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Smallest.ai API error', details: errText });
    }

    const audioBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/wav');
    res.send(Buffer.from(audioBuffer));
  } catch (error) {
    console.error('Smallest.ai Proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ElevenLabs TTS Proxy
app.post('/api/synthesize-voice/elevenlabs', verifyUser, async (req, res) => {
  try {
    const { text, voice_id } = req.body;
    const voiceId = voice_id || 'pNInz6obpgDQGcFmaJgB';

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.5 }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'ElevenLabs API error', details: errText });
    }

    const audioBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (error) {
    console.error('ElevenLabs Proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// NATURAL STUDIO TTS (Pastor Eddy & Richel - American Voices)
// 100% Free • No API Key • No Google Billing • No Quota Limits
// ============================================================
app.post('/api/tts', async (req, res) => {
  try {
    const { text, language = 'en', teacher = 'Pastor Eddy', gender = 'male' } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text parameter is required' });
    }

    const cleanText = text.trim();
    const isFemale = teacher === 'Richel' || gender === 'female';

    // American Voices:
    // Richel: en-US-JennyNeural (Warm, clear, natural American educator)
    // Pastor Eddy: en-US-GuyNeural (Articulate, resonant, natural American educator)
    let selectedVoice;
    if (language === 'fr') {
      selectedVoice = isFemale ? 'fr-FR-DeniseNeural' : 'fr-FR-HenriNeural';
    } else {
      selectedVoice = isFemale ? 'en-US-JennyNeural' : 'en-US-GuyNeural';
    }

    // Cache key based on voice and sentence text
    const cacheKey = crypto
      .createHash('md5')
      .update(`${selectedVoice}_${cleanText}`)
      .digest('hex');

    // Return instant cached MP3 if already spoken before
    if (ttsCache.has(cacheKey)) {
      return res.json({
        audioBase64: ttsCache.get(cacheKey),
        mimeType: 'audio/mp3',
        voiceName: selectedVoice,
        teacher: teacher,
        cached: true,
      });
    }

    // Synthesize studio MP3 audio via Microsoft Edge Neural cloud
    const tts = new MsEdgeTTS();
    await tts.setMetadata(selectedVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const { audioStream } = tts.toStream(cleanText);
    const chunks = [];

    await new Promise((resolve, reject) => {
      audioStream.on('data', (chunk) => chunks.push(chunk));
      audioStream.on('end', () => {
        tts.close();
        resolve();
      });
      audioStream.on('error', (err) => {
        tts.close();
        reject(err);
      });
    });

    const audioBuffer = Buffer.concat(chunks);
    const audioBase64 = audioBuffer.toString('base64');

    // Store in cache (up to 1,000 sentences to protect memory)
    if (ttsCache.size < 1000) {
      ttsCache.set(cacheKey, audioBase64);
    }

    return res.json({
      audioBase64: audioBase64,
      mimeType: 'audio/mp3',
      voiceName: selectedVoice,
      teacher: teacher,
      cached: false,
    });
  } catch (err) {
    console.error('TTS error on Render:', err);
    return res.status(500).json({ error: err.message || 'Speech generation failed' });
  }
});

// ============================================================
// ADMIN ACTIONS (Requires Admin Auth)
// ============================================================
app.post('/api/admin/add-time', verifyAdmin, async (req, res) => {
  try {
    const { userId, hours, reason } = req.body;

    if (!userId || !hours) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const subscription = userData.subscription || {};

    let currentExpiry = new Date();
    if (subscription.expiryTime) {
      currentExpiry = subscription.expiryTime.toDate();
      if (currentExpiry < new Date()) {
        currentExpiry = new Date();
      }
    }

    const newExpiry = new Date(currentExpiry);
    newExpiry.setHours(newExpiry.getHours() + parseInt(hours));

    await userRef.update({
      'subscription.hasPaid': true,
      'subscription.isActive': true,
      'subscription.expiryTime': admin.firestore.Timestamp.fromDate(newExpiry),
      'subscription.lastManualAdd': admin.firestore.FieldValue.serverTimestamp(),
      'subscription.manualAddReason': reason || 'Admin manual extension',
      'subscription.hoursAdded': parseInt(hours),
      'updatedAt': admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: `Added ${hours} hours to user successfully`,
      newExpiry: newExpiry.getTime()
    });
  } catch (error) {
    console.error('Admin add time error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Secure Phronimos API running on port ${PORT}`);
});
