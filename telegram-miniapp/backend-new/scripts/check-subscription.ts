/**
 * Check subscription status
 * Usage: npx ts-node scripts/check-subscription.ts <telegramId>
 */

import fetch from 'node-fetch';

const API_URL = process.env.API_URL || 'http://localhost:3001';

async function checkSubscription() {
  const telegramId = process.argv[2];

  if (!telegramId) {
    console.error('Usage: npx ts-node scripts/check-subscription.ts <telegramId>');
    process.exit(1);
  }

  console.log('Checking subscription for user:', telegramId);

  try {
    const response = await fetch(`${API_URL}/api/subscription/status?userId=${telegramId}`);
    const data = await response.json();

    if (data.success) {
      console.log('✅ User exists:', data.userExists);
      console.log('✅ Subscription active:', data.active);
      if (data.subscriptionEnd) {
        console.log('📅 Valid until:', new Date(data.subscriptionEnd).toLocaleString());
      }
    } else {
      console.error('❌ Error:', data.error);
    }
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

checkSubscription();
