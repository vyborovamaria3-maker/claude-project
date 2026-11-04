import hashlib
import json
import unittest
from app.token_wallet_relations import analyze_records,analyze_archive

def row(i,wallet,slot,stamp,amount=.1,side='buy'):
 return dict(signature='sig'+str(i),wallet=wallet,slot=slot,timestamp=stamp,amountSol=amount,amountTokens=1,side=side,archiveLine=i+2)

class WalletRelationsTests(unittest.TestCase):
 def test_zero_amounts_never_create_a_wallet_group(self):
  r=analyze_records([row(i,str(i),1,100,0) for i in range(5)],'mint','a'*64,10)
  self.assertEqual(r['summary']['zeroSolBuys'],5)
  self.assertEqual(r['summary']['sameSlotGroups'],0)
  self.assertEqual(r['groups'],[])
 def test_repeated_group_is_deduplicated_by_wallet_and_slot(self):
  rows=[]
  for slot,stamp in [(1,100),(2,101),(3,150),(4,151)]:
   for wallet in ['a','b','c']:rows.append(row(len(rows),wallet,slot,stamp))
  rows.append(row(len(rows),'a',1,100))
  r=analyze_records(rows,'mint','a'*64,10)
  self.assertEqual(len(r['groups']),1)
  self.assertEqual(len(r['groups'][0]['sharedBuySlots']),4)
  self.assertEqual(len(r['groups'][0]['episodes']),2)
  self.assertEqual(r['summary']['strongTemporalEdges'],3)
  self.assertEqual(r['control'],analyze_records(rows,'mint','a'*64,10)['control'])
 def test_one_launch_burst_is_not_claimed_as_repeated_episodes(self):
  rows=[row(slot*3+i,w,slot,100+slot) for slot in range(1,5) for i,w in enumerate(['a','b','c'])]
  r=analyze_records(rows,'mint','a'*64,0)
  self.assertEqual(r['groups'],[])
  self.assertEqual(r['pairs'],[])
 def test_conflicting_slot_and_same_slot_buy_sell_order_are_not_proof(self):
  rows=[row(1,'a',10,100),row(2,'b',10,101)]
  for i in range(3):rows.extend([row(3+2*i,'z',20+i,200+i,side='buy'),row(4+2*i,'z',20+i,200+i,side='sell')])
  r=analyze_records(rows,'mint','a'*64,0)
  self.assertEqual(r['summary']['conflictingSlots'],1)
  self.assertEqual(r['rapidExamples'],[])
 def test_archive_tampering_and_duplicate_signatures_fail_closed(self):
  data=b'["stored-chain-v1","mint"]\n'
  with self.assertRaisesRegex(ValueError,'hash_mismatch'):analyze_archive(data,'0'*64)
  r=row(1,'a',1,100)
  with self.assertRaises(ValueError):analyze_records([r,r],'mint','a'*64)

if __name__=='__main__':unittest.main()
