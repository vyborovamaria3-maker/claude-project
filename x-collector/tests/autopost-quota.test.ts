import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {checkAccountQuotas} from './autopost-quota-fixture';
test('account quotas preserve manual-first, pause, windows, identity/breaker guards and attempted cutoff without per-job aggregates',async()=>{
 const db=new PGlite();try{await checkAccountQuotas(db);}finally{await db.close();}
});
