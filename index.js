require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ============================================================
// INITIALIZE FIREBASE ADMIN - READ SECRET FILE FROM RENDER
// ============================================================
if (!admin.apps.length) {
  // Try to read the secret file from Render
  const secretPath = '/etc/secrets/service-account-key.json';
  
  if (fs.existsSync(secretPath)) {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('✅ Firebase Admin initialized with service account from Render secret');
    } catch (error) {
      console.error('❌ Failed to parse service account:', error.message);
    }
  } else {
    console.error('❌ Secret file not found at:', secretPath);
  }
}

const db = admin.firestore();

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({ message: 'Phronimos API is running', status: 'ok' });
});

// ============================================================
// VERIFY PAYMENT
// ============================================================
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { reference, userId, email } = req.body;
    
    console.log('Verifying payment for user:', userId);
    
    if (!reference || !userId) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    
    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET_KEY) {
      console.error('PAYSTACK_SECRET_KEY not set');
      return res.status(500).json({ success: false, error: 'Config error' });
    }
    
    // Verify with Paystack
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (data.status && data.data.status === 'success') {
      // Update Firestore
      const expiryTime = admin.firestore.Timestamp.fromMillis(Date.now() + (24 * 60 * 60 * 1000));
      
      await db.collection('users').doc(userId).update({
        'subscription.hasPaid': true,
        'subscription.isActive': true,
        'subscription.expiryTime': expiryTime,
        'subscription.paymentReference': reference,
        'subscription.paymentDate': admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log('✅ Subscription updated for:', userId);
      
      res.json({ 
        success: true, 
        message: 'Payment verified',
        expiryTime: expiryTime.toMillis()
      });
    } else {
      console.log('❌ Payment verification failed:', data.data?.status);
      res.json({ success: false, error: 'Payment not successful' });
    }
    
  } catch (error) {
    console.error('Payment error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// CHECK SUBSCRIPTION
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
      expiryTime: subscription.expiryTime ? subscription.expiryTime.toMillis() : null
    });
    
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Phronimos API running on port ${PORT}`);
});
