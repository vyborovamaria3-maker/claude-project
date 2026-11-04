import unittest
from core import addresses,valid_address,evaluate,PriceSource,INTERVAL,digest
MINT='5dBB7trtJaHKrRhnDzPrbmZny3QJNeEGVMaBSBa8pump'
POOL='So11111111111111111111111111111111111111112'
class Tests(unittest.TestCase):
 def test_exact_address_not_ticker_or_partial(self):
  self.assertTrue(valid_address(MINT));self.assertEqual(addresses('$SOL '+MINT+' https://pump.fun/coin/'+MINT),[MINT]);self.assertEqual(addresses('X'+MINT+'Z'),[]);self.assertFalse(valid_address('z'*44))
 def proof(self,rows):return dict(source='geckoterminal',currency='usd',interval_ms=INTERVAL,fetched_at=100000000,candles=rows)
 def test_no_pre_post_entry_and_costs(self):
  p=self.proof([[0,99,99,99,99,1],[300000,1,1,1,1,1],[3900000,2,2,2,2,1]])
  result,reason=evaluate(p,1,1,100000000);self.assertIsNone(reason);self.assertEqual(result['entry_at'],300000);self.assertAlmostEqual(result['net_return'],2*.99/1.01-1)
 def test_missing_immature_untraded_future(self):
  p=self.proof([[0,1,1,1,1,0],[300000,1,1,1,1,0]])
  self.assertEqual(evaluate(p,1,1,100000000)[1],'entry_price_missing')
  p=self.proof([[300000,1,1,1,1,1]])
  self.assertEqual(evaluate(p,1,1,1000000)[1],'immature');self.assertEqual(evaluate(p,1,1,100000000)[1],'future_price_missing')
 def test_no_unclosed_or_future_evidence(self):
  p=self.proof([[300000,1,1,1,1,1],[3900000,2,2,2,2,1]]);p['fetched_at']=4000000
  self.assertEqual(evaluate(p,1,1,100000000)[1],'unclosed_candle')
  p['fetched_at']=100000001;self.assertEqual(evaluate(p,1,1,100000000)[1],'unclosed_candle')
 def test_wrong_identity_rejected_and_history_anchored(self):
  calls=[]
  pool=dict(type='pool',id='solana_'+POOL,attributes={'address':POOL,'reserve_in_usd':'10000'},relationships={'base_token':{'data':{'type':'token','id':'solana_'+MINT}},'quote_token':{'data':{'type':'token','id':'solana_'+POOL}}})
  def fetch(url):
   calls.append(url)
   return {'data':[pool]} if '/tokens/' in url else {'data':{'type':'ohlcv_request_response','attributes':{'ohlcv_list':[[300,1,1,1,1,2]]}},'meta':{'base':{'address':MINT},'quote':{'address':POOL}}}
  source=PriceSource(fetch=fetch,clock=lambda:1000000000,sleep=lambda _:None);p=source.history(MINT,1)
  self.assertIn('before_timestamp=262800',calls[-1]);self.assertEqual(p['candles'][0][0],300000);self.assertEqual(digest(p),digest(p))
  def bad(url):
   data=fetch(url)
   if '/tokens/' not in url:data['meta']['base']['address']=POOL
   return data
  with self.assertRaisesRegex(ValueError,'identity'):PriceSource(fetch=bad,clock=lambda:1000000000,sleep=lambda _:None).history(MINT,1)
 def test_wallet_without_confirmed_pool_never_token(self):
  with self.assertRaisesRegex(ValueError,'not_confirmed'):PriceSource(fetch=lambda _:dict(data=[]),clock=lambda:1000000000,sleep=lambda _:None).history('1'*32,1)
 def test_thin_price_is_explicitly_flagged(self):
  p=self.proof([[300000,1,1,1,1,1000],[3900000,2,2,2,2,.1]]);r,reason=evaluate(p,1,1,100000000);self.assertIsNone(reason);self.assertEqual(r['price_quality'],'thin_candle');self.assertEqual(r['exit_volume_usd'],.1)
if __name__=='__main__':unittest.main()
