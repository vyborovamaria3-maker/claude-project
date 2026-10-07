async function refresh() {
 const button=document.querySelector('#refresh');button.disabled=true;
 try {
 const r=await fetch('/api/archive/status');if(!r.ok)throw new Error('HTTP '+r.status);const data=await r.json();
 document.querySelector('#error').textContent='';document.querySelector('#counts').textContent=JSON.stringify(data.counts,null,2);
 for(const [id,rows] of [['sources',data.sources.map(s=>[s.name+' — '+s.url,s.license,s.kind])],['jobs',data.jobs.map(j=>[j.id+' / '+j.query,j.start_at+' → '+j.end_at,j.state,j.pages+' / '+j.posts_seen,j.last_error??''])]]){
 const body=document.getElementById(id);body.replaceChildren();for(const values of rows){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}body.append(tr);}
 }
 }catch(e){document.querySelector('#error').textContent='Не удалось загрузить архив: '+e.message;}
 finally{button.disabled=false;}
}
document.querySelector('#refresh').addEventListener('click',refresh);void refresh();
