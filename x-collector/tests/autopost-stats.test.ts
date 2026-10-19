import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {checkAutopostStatistics} from './autopost-stats-fixture';
test('autopost statistics execute real SQL and retain latest Moscow-day snapshots, account isolation and NULL metrics',async()=>{
 const db=new PGlite();
 try{await checkAutopostStatistics(db);}finally{await db.close();}
});
