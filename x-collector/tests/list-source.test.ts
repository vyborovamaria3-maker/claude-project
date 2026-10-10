import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionUrl, listId } from '../lib/trade/list-source';
test('list sources navigate to the requested list, preserving all ID digits', () => {
  for (const id of ['1878727153048777016','953048248406519809','1945268064792068152'])
    assert.equal(collectionUrl(`list:${id}`, 'latest'), `https://x.com/i/lists/${id}`);
  assert.equal(listId('list:123/other'), null);
  assert.equal(listId('list:123 OR bitcoin'), null);
  assert.equal(collectionUrl('bitcoin & solana', 'latest'), 'https://x.com/search?q=bitcoin%20%26%20solana&src=typed_query&f=live');
});
