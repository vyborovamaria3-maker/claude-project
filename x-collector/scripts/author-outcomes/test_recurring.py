import unittest
from recurring import recurring_analysis

def group(id,mint,at=0,edges=None):
 members=[dict(tweet_id=x,author=x,posted_at=at,source_text=x,source_hash=x,outcomes={'24':{'net_return':.1,'evidence_hash':'proof'}}) for x in ['a','b','c']]
 e=[dict(a=a,b=b,gap_seconds=1,word_jaccard=.8,character_dice=.9,anchors=['example']) for a,b in (edges or [('a','b'),('a','c'),('b','c')])]
 return dict(id=id,mint=mint,members=members,authors=['a','b','c'],edges=e,token_confirmed=False,span_seconds=2,first_at=at)
class Tests(unittest.TestCase):
 def test_same_ca_and_overlapping_windows_never_inflate_support(self):
  groups=[group('x','one'),group('y','one')];rows=[dict(author=x,mint='one') for x in ['a','b','c']];r=recurring_analysis(groups,rows,0)
  self.assertEqual(r['coverage']['recurrent_pairs'],0);self.assertEqual(r['coverage']['recurrent_triangles'],0);self.assertEqual(r['coverage']['priced_post_horizons'],3)
 def test_two_ca_count_once_and_baseline_is_visible(self):
  groups=[group('x','one'),group('y','one'),group('z','two',86400000)];rows=[dict(author=x,mint=m) for x in ['a','b','c'] for m in ['one','two','extra']];r=recurring_analysis(groups,rows,0)
  self.assertEqual(r['pairs'][0]['distinct_ca'],2);self.assertEqual(r['pairs'][0]['utc_days'],2);self.assertEqual(r['pairs'][0]['author_total_ca']['a'],3);self.assertEqual(r['trios'][0]['distinct_ca'],2)
 def test_transitive_co_membership_does_not_establish_direct_pair_or_trio(self):
  groups=[group('x','one',edges=[('a','b'),('b','c')]),group('y','two',edges=[('a','b'),('b','c')])];rows=[dict(author=x,mint=m) for x in ['a','b','c'] for m in ['one','two']];r=recurring_analysis(groups,rows,0)
  self.assertEqual(len(r['pairs']),2);self.assertEqual(r['trios'],[]);self.assertNotIn(['a','c'],[p['authors'] for p in r['pairs']])
if __name__=='__main__':unittest.main()
