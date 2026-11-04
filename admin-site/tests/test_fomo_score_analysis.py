import unittest
from app.fomo_score_analysis import analyze_score_rows, ranks, spearman

def row(i,mint=None,pressure=20,quality=70,ret=1):
 return dict(snapshot_id=str(i),mint=mint or str(i),signal_at=i,completed_at=i,pressure=pressure,quality=quality,coverage=.075,return_pct=ret,drawdown_pct=-2,x_count=0,tg_count=1)

class ScoreAnalysisTests(unittest.TestCase):
 def test_ties_constant_and_inverse_ranks(self):
  self.assertEqual(ranks([10,10,30]),[1.5,1.5,3])
  self.assertIsNone(spearman([row(i) for i in range(4)],'pressure'))
  rows=[row(i,pressure=i,ret=-i) for i in range(4)]
  self.assertAlmostEqual(spearman(rows,'pressure'),-1)
 def test_first40_stays_fixed_as_future_outcomes_accumulate(self):
  rows=[row(i,mint=str(i%8),pressure=i%3,ret=i-20) for i in range(44)]
  first=analyze_score_rows(rows[:40]);extended=analyze_score_rows(list(reversed(rows)))
  self.assertEqual(first['all'],extended['all'])
  self.assertEqual(extended['all']['n'],40)
  self.assertEqual(extended['current']['all']['n'],44)
  self.assertEqual(extended['one_per_token']['n'],8)
  self.assertEqual([r['signal_at'] for r in extended['token_representatives']],list(range(8)))
 def test_linked_counterexamples_require_same_token_same_scores(self):
  rows=[row(0,'same',ret=-5),row(1,'same',ret=8),row(2,'other',ret=100),row(3,'same',pressure=99,ret=50)]
  a=analyze_score_rows(rows)
  example=a['examples'][0]
  self.assertEqual(example['mint'],'same')
  self.assertEqual(example['spread'],13)
  self.assertEqual(example['positive']['snapshot_id'],'1')
  self.assertEqual(a['status'],'predictive_link_not_established')
 def test_empty_and_invalid_numeric_evidence_never_produces_a_correlation(self):
  a=analyze_score_rows([row(0,ret=float('nan'))])
  self.assertEqual(a['invalid_rows'],1)
  self.assertIsNone(a['all']['pressure_rho'])
  self.assertIsNone(a['coverage_range'])

if __name__=='__main__':unittest.main()
