import unittest
from groups import detect,features
M='DBPTU2oKLDHXQjAEJ3rZi8bUGmt2uxUbipgg6xmXoMqr'
def row(i,author,at,text,mint=M):return dict(tweet_id=str(i),author=author,posted_at=at,source_text=text,mint=mint,token_status='confirmed')
class GroupsTests(unittest.TestCase):
 def test_common_address_url_ticker_do_not_make_similarity(self):
  text=M+' https://same.example/airdrop $CAPY';self.assertEqual(features(text)[0],set());self.assertEqual(detect([row(i,str(i),i*1000,text) for i in range(3)])[0],[])
 def test_three_authors_same_window_and_text_proof(self):
  text='Capytistas WIRED capybaras replace the dominant dogs narrative'
  groups,n=detect([row(i,str(i),i*1000,text) for i in range(3)]);self.assertEqual(len(groups),1);self.assertEqual(len(groups[0]['edges']),3);self.assertEqual(groups[0]['span_seconds'],2)
 def test_far_apart_same_author_or_other_token_are_not_group(self):
  text='Capytistas WIRED capybaras replace the dominant dogs narrative'
  for rows in [[row(1,'a',0,text),row(2,'b',1000,text),row(3,'c',1000000,text)],[row(i,'a',i*1000,text) for i in range(3)],[row(i,str(i),i*1000,text,mint=str(i)) for i in range(3)]]:self.assertEqual(detect(rows)[0],[])
 def test_cross_language_shared_names_and_window_not_chained(self):
  rows=[row(1,'a',0,'Capytistas WIRED capybara community'),row(2,'b',500000,'Capytistas WIRED 关于水豚的故事'),row(3,'c',800000,'Capytistas WIRED 水豚'),row(4,'d',1300000,'Capytistas WIRED 水豚')]
  groups,_=detect(rows);self.assertTrue(groups);self.assertTrue(all(g['span_seconds']<=900 for g in groups));self.assertFalse(any(len(g['authors'])==4 for g in groups))
if __name__=='__main__':unittest.main()
