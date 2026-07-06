require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin (already set up)
const fs = require('fs');

if (!admin.apps.length) {
  const secretPath = '/etc/secrets/service-account-key.json';
  const serviceAccount = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({ message: 'Phronimos API is running', status: 'ok' });
});

// ============================================================
// VERIFY PAYMENT - SECURE (uses Paystack Secret Key)
// ============================================================
app.post('/api/verify-payment', async (req, res) => {
  // ===== TEMPORARY LOGGING - REMOVE AFTER FIX =====
  console.log('RAW BODY RECEIVED:', JSON.stringify(req.body));
  // ================================================
  
  try {
    const { reference, userId, email, amount } = req.body;
    
    // Log each field individually
    console.log('📊 Extracted fields:');
    console.log('  - reference:', reference);
    console.log('  - userId:', userId);
    console.log('  - email:', email);
    console.log('  - amount:', amount);
    
    if (!reference || !userId) {
      console.log('❌ Rejected - Missing required fields:');
      console.log('  - reference present:', !!reference);
      console.log('  - userId present:', !!userId);
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    console.log('✅ Validation passed, proceeding to Paystack verification...');
    
    // Verify with Paystack API using SECRET KEY from environment
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    console.log('📊 Paystack response status:', data.status);
    console.log('📊 Paystack data status:', data.data?.status);
    
    if (!data.status || !data.data || data.data.status !== 'success') {
      console.log('❌ Payment verification failed:', data.message);
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    
    console.log('✅ Payment verified successfully!');
    
    // Payment is valid - update Firestore
    const expiryTime = admin.firestore.Timestamp.fromMillis(Date.now() + (24 * 60 * 60 * 1000));
    
    await db.collection('users').doc(userId).update({
      'subscription.hasPaid': true,
      'subscription.isActive': true,
      'subscription.purchaseTime': admin.firestore.FieldValue.serverTimestamp(),
      'subscription.expiryTime': expiryTime,
      'subscription.paymentReference': reference,
      'subscription.amountPaid': amount || 200,
      'updatedAt': admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Subscription activated for user ${userId} until ${new Date(expiryTime.toMillis()).toISOString()}`);
    
    // Also save payment record
    await db.collection('payments').add({
      userId: userId,
      email: email,
      reference: reference,
      amount: amount || 200,
      currency: 'GHS',
      status: 'success',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ 
      success: true, 
      message: 'Payment verified and subscription activated for 24 hours',
      expiryTime: expiryTime.toMillis()
    });
    
  } catch (error) {
    console.error('❌ Payment verification error:', error);
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
