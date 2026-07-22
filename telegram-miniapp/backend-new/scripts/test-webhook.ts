/**
 * Test script for Helius webhook locally
 * Usage: npx ts-node scripts/test-webhook.ts <memo> <signature>
 */

import fetch from 'node-fetch';

const API_URL = process.env.API_URL || 'http://localhost:3001';

// Mock Helius webhook payload
function createMockPayload(memo: string, signature: string) {
  return [
    {
      signature,
      type: 'TRANSFER',
      memo,
      tokenTransfers: [
        {
          mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
          toUserAccount: process.env.MERCHANT_WALLET || 'YOUR_MERCHANT_WALLET',
          fromUserAccount: 'SENDER_WALLET_ADDRESS',
          tokenAmount: 1000,
        },
      ],
    },
  ];
}

async function testWebhook() {
  const memo = process.argv[2];
  const signature = process.argv[3] || '5x'.repeat(17) + 'x'; // mock signature

  if (!memo) {
    console.error('Usage: npx ts-node scripts/test-webhook.ts <memo> [signature]');
    console.error('Example: npx ts-node scripts/test-webhook.ts 123456789_1699999999999');
    process.exit(1);
  }

  const payload = createMockPayload(memo, signature);

  console.log('Sending mock Helius webhook...');
  console.log('Memo:', memo);
  console.log('URL:', `${API_URL}/webhook/helius`);

  try {
    const response = await fetch(`${API_URL}/webhook/helius`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log('✅ Webhook accepted');
    } else {
      console.error('❌ Webhook rejected:', response.status);
      const text = await response.text();
      console.error(text);
    }
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

testWebhook();
