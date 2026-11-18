import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

FOLDER=Path(__file__).resolve().parents[1]

def load(name):
    spec=importlib.util.spec_from_file_location(name,FOLDER/(name+".py"))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

ingest=load("ingest")
norm=load("normalize")
MINT="5njPgyEfBDvGxHtMTN86yQnNr1XTd3zy9D2eb84zpump"


class SourceProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.db=self.root/"staging.sqlite"
        self.auth=self.root/"auth.json"

    def approve(self,source):
        self.auth.write_text(json.dumps({source:{"status":"approved",
            "allowed_uses":["research"],"reviewed_by":"fixture",
            "evidence_reference":"synthetic-test-rights"}}),encoding="utf8")

    def test_pubkey_syntax_not_mint_verification(self):
        self.assertTrue(norm.valid_solana_pubkey(MINT))
        self.assertFalse(norm.valid_solana_pubkey("So11111"))
        self.assertFalse(norm.valid_solana_pubkey("0x"+"ab"*20))
        self.assertFalse(norm.valid_solana_pubkey("O"*32))

    def test_coin_meme_time_and_outcomes_separated(self):
        self.approve("coin-meme")
        file=self.root/"destription+finance.csv"
        file.write_text(
            "token_name,token_ticker,token_address,description,mCap,createdAt,bonding_completeTime\n"
            "Test Token,TEST,"+MINT+",a meme,\"5,599\",\"13/10/2024, 08:31:20\",\"13/10/2024, 08:33:39\"\n",
            encoding="utf8")
        ingest.import_file("coin-meme",file,self.db,self.auth)
        result=norm.project_source(self.db,"coin-meme")
        self.assertEqual(result["inserted"],1)
        self.assertFalse(result["chain_mint_verified"])
        with sqlite3.connect(self.db) as db:
            value=db.execute(
                "SELECT mint_candidate,source_created_raw,source_time_precision,"
                "first_system_available_at,mint_verified FROM token_metadata_projections"
            ).fetchone()
            outcome=db.execute(
                "SELECT market_cap_snapshot_raw,bonding_complete_time_raw FROM token_outcomes_research_only"
            ).fetchone()
        self.assertEqual(value[0],MINT)
        self.assertEqual(value[1],"13/10/2024, 08:31:20")
        self.assertEqual(value[2],"unknown_timezone")
        self.assertGreater(value[3],"2026-01-01")
        self.assertEqual(value[4],0)
        self.assertEqual(outcome,("5,599","13/10/2024, 08:33:39"))
        replay=norm.project_source(self.db,"coin-meme")
        self.assertEqual(replay["inserted"],0)

    def test_memechain_sol_only_and_urls_not_verified(self):
        self.approve("memechain")
        file=self.root/"social_info.csv"
        file.write_text(
            "address,platform,website,twitter,telegram,discord\n"
            +MINT+",Solana,https://project.test,https://x.com/test,,https://discord.gg/test\n"
            +"0x"+"ab"*20+",ethereum,https://ethereum.test,,,\n"
            +MINT+",Solana,,javascript:alert(1),,\n",encoding="utf8")
        ingest.import_file("memechain",file,self.db,self.auth)
        result=norm.project_source(self.db,"memechain")
        self.assertEqual(result["inserted"],1)
        with sqlite3.connect(self.db) as db:
            values=db.execute(
                "SELECT mint_candidate,discord,source_platform,mint_verified FROM token_social_link_projections"
            ).fetchall()
        self.assertEqual(values,[(MINT,"https://discord.gg/test","solana",0)])

    def test_no_guessing_coin_meme_comment_join(self):
        self.approve("coin-meme")
        file=self.root/"comments.csv"
        file.write_text("comment_id,comment\n1,fun token\n",encoding="utf8")
        ingest.import_file("coin-meme",file,self.db,self.auth)
        result=norm.project_source(self.db,"coin-meme")
        self.assertEqual(result["processed"],1)
        self.assertEqual(result["inserted"],0)


if __name__=="__main__":
    unittest.main()
