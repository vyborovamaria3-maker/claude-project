import unittest
from timing import assess

def proof():
 rows=[[t,1,1,1,1,1000] for t in range(3600000,7200000,300000)]
 rows += [[7500000,1,1,1,1,1000],[11100000,2,2,2,2,1000]]
 return dict(source='geckoterminal',currency='usd',interval_ms=300000,fetched_at=1000000000,candles=rows)
class Tests(unittest.TestCase):
 def test_before_later_growth_needs_complete_pre_hour(self):
  p=proof();r=assess(p,7200001,1000000000);self.assertEqual(r['label'],'before_later_growth');self.assertEqual(r['growth_horizons'],[1]);self.assertEqual(r['pre']['last_close_at'],7200000)
  p['candles'].pop(1);r=assess(p,7200001,1000000000);self.assertEqual(r['label'],'later_growth_prior_unknown');self.assertIsNone(r['pre'])
 def test_already_after_jump_can_still_grow_later(self):
  p=proof();p['candles'][3][2]=2;r=assess(p,7200001,1000000000);self.assertEqual(r['label'],'after_prior_jump');self.assertEqual(r['growth_horizons'],[1]);self.assertEqual(r['pre']['peak_gain_1h'],1)
 def test_overlapping_post_candle_never_leaks_into_pre_window(self):
  p=proof();p['candles'].append([7200000,1,999,1,1,1000]);r=assess(p,7200001,1000000000);self.assertEqual(r['pre']['peak_gain_1h'],0);self.assertEqual(r['label'],'before_later_growth')
 def test_untraded_or_missing_prices_are_unknown(self):
  p=proof();p['candles'][2][5]=0;p['candles']=[c for c in p['candles'] if c[0]<7500000];r=assess(p,7200001,1000000000);self.assertEqual(r['label'],'insufficient_history')
 def test_partial_prior_window_can_witness_jump_but_not_absence(self):
  p=proof();p['candles']=[[3600000,.1,.1,.1,.1,1000],[3900000,1,1,1,1,1000],[7500000,1,1,1,1,1000]]
  r=assess(p,7200001,1000000000);self.assertIsNone(r['pre']);self.assertEqual(r['label'],'after_prior_jump');self.assertAlmostEqual(r['observed_prior_24h']['observed_max_rise'],9)
 def test_future_evidence_is_never_used_for_prior_label(self):
  p=proof();r=assess(p,7200001,999999999);self.assertEqual(r['label'],'insufficient_history');self.assertIsNone(r['observed_prior_24h'])
 def test_thin_future_quote_does_not_establish_early_growth(self):
  p=proof();p['candles'][-1][5]=.1;r=assess(p,7200001,1000000000);self.assertEqual(r['outcomes']['1']['price_quality'],'thin_candle');self.assertEqual(r['growth_horizons'],[]);self.assertEqual(r['label'],'insufficient_history')
 def test_first_stored_context_is_checked_outside_cluster_and_counted_once(self):
  from timing import timing_report
  late=dict(tweet_id='late',author='a',posted_at=7200001,source_text='late',source_hash='h')
  first=dict(tweet_id='first',mint='M',author='a',posted_at=6600001,source_text='first',source_hash='h')
  history=proof();history['mint']='M'
  class Result:
   def __init__(self,rows):self.rows=rows
   def fetchall(self):return self.rows
  class DB:
   def execute(self,sql,args):return Result([first] if 'DISTINCT ON' in sql else [dict(mint='M',evidence_hash='p',proof=history)])
  r=timing_report(DB(),[dict(id='g',mint='M',members=[late])],1000000000)
  self.assertEqual(r['coverage']['group_posts_ca'],1);self.assertEqual(r['coverage']['earlier_context_posts'],1);self.assertEqual(r['authors'][0]['distinct_ca'],1)
  first_row=next(x for x in r['records'] if x['tweet_id']=='first');self.assertTrue(first_row['first_stored_mention']);self.assertEqual(first_row['scope'],'earlier_context')
if __name__=='__main__':unittest.main()
