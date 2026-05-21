require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
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
// TEST ENDPOINT
// ============================================================
app.get('/api/test', (req, res) => {
  res.json({ message: 'API is working!' });
});

// ============================================================
// VERIFY PAYMENT
// ============================================================
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { reference, userId, email, amount } = req.body;
    
    if (!reference || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (!data.status || !data.data || data.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    
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
    console.error('Payment verification error:', error);
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
    
    if (userData.subscription?.hasPaid && userData.subscription.expiryTime?.toMillis() > Date.now()) {
      return res.json({ success: true, message: 'Premium already active', trialActive: false });
    }
    
    const lastReset = userData.trial?.lastTrialReset?.toMillis() || 0;
    const hoursSinceReset = (Date.now() - lastReset) / (1000 * 60 * 60);
    
    if (hoursSinceReset >= 24) {
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
      res.json({ success: true, trialActive: true, trialExpiryTime: userData.trial.trialEndTime.toMillis() });
    } else {
      res.json({ success: false, trialActive: false, message: 'No trial available. Please upgrade.' });
    }
    
  } catch (error) {
    console.error('Error starting trial:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// SAVE PROGRESS
// ============================================================
app.post('/api/save-progress', async (req, res) => {
  try {
    const { userId, progress } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    
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

// Start server
app.listen(PORT, () => {
  console.log(`✅ Secure Phronimos API running on port ${PORT}`);
});
