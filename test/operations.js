'use strict';
/* Phase 7 authentication, printing and operator-backup regressions. */
const fs=require('fs');const BASE=process.env.BASE;let passed=0,failed=0;
const ck=(n,o,d='')=>{if(o){passed++;console.log('  ✓',n);}else{failed++;console.error('  ✗',n,d);}};
const mk=()=>{let cookie='';const req=async(method,path,body,headers={})=>{const res=await fetch(BASE+path,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});const sc=res.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];const ct=res.headers.get('content-type')||'';return{status:res.status,data:ct.includes('json')?await res.json():await res.text()};};return{get:(p)=>req('GET',p),post:(p,b,h)=>req('POST',p,b,h),put:(p,b,h)=>req('PUT',p,b,h)};};
(async()=>{
 console.log('\n=== Phase 7 operations hardening ===\n');
 const admin=mk(),seller=mk();await admin.post('/api/login',{pin:'0000'});await seller.post('/api/login',{pin:'1234'});
 const boot=(await seller.get('/api/bootstrap')).data;await seller.post('/api/shifts',{opening_float:0,opening_mpesa:0,opening_card:0});
 let order=(await seller.post('/api/orders',{})).data;await seller.post(`/api/orders/${order.id}/items`,{items:[{menu_item_id:boot.menu[0].id,qty:1}]});
 let r=await seller.post(`/api/orders/${order.id}/void`,{reason:'not approved'});ck('seller cannot use protected action directly',r.status===403,JSON.stringify(r.data));
 r=await seller.post('/api/authorize',{pin:'0000'});const approval=r.data.approval_token;
 ck('owner PIN returns short-lived action approval without login',r.status===200&&approval&&r.data.expires_in_seconds===120,JSON.stringify(r.data));
 r=await seller.post(`/api/orders/${order.id}/void`,{reason:'approved test'},{'X-POS-Approval':approval});
 ck('one-use approval permits protected action',r.status===200,JSON.stringify(r.data));
 r=await seller.get('/api/me');ck('approval does not replace seller session',r.status===200&&r.data.user.role==='seller',JSON.stringify(r.data));
 r=await seller.post(`/api/orders/${order.id}/void`,{reason:'reused'},{'X-POS-Approval':approval});
 ck('approval token cannot be reused',r.status===403,JSON.stringify(r.data));
 r=await seller.post('/api/authorize',{pin:'1234'});ck('seller PIN cannot approve manager action',r.status===403,JSON.stringify(r.data));

 r=await admin.post('/api/users',{name:'Six Digit Test',pin:'654321',role:'seller'});ck('existing 4-6 digit PIN policy remains supported',r.status===200,JSON.stringify(r.data));
 const six=mk();r=await six.post('/api/login',{pin:'654321'});ck('six-digit account authenticates',r.status===200&&r.data.user.name==='Six Digit Test',JSON.stringify(r.data));

 order=(await seller.post('/api/orders',{})).data;r=await seller.post(`/api/orders/${order.id}/items`,{items:[{menu_item_id:boot.menu[0].id,qty:1}]});
 const amount=r.data.totals.grand_total/100;
 r=await seller.post(`/api/orders/${order.id}/pay`,{method:'cash',amount,tendered:amount,idempotency_key:'ops-print-sale'});
 const line=r.data.order.items[0];
 const ret=await admin.post(`/api/orders/${order.id}/refund`,{method:'cash',amount,reason:'Operations print test',restock:false,
   idempotency_key:'ops-return',items:[{order_item_id:line.id,qty:1}]});
 r=await admin.post('/api/print/return/'+ret.data.return_record.id,{});
 const returnBytes=r.status===200&&r.data.spool?fs.readFileSync(r.data.spool):Buffer.alloc(0);
 ck('return receipt uses server ESC/POS path',r.status===200&&returnBytes.includes(Buffer.from('RETURN / REFUND'))&&returnBytes.includes(Buffer.from('REFUNDED')),JSON.stringify(r.data));
 r=await seller.post(`/api/print/receipt/${order.id}?paid=1&reprint=1&kick=1`,{});
 const reprintBytes=r.status===200&&r.data.spool?fs.readFileSync(r.data.spool):Buffer.alloc(0);
 ck('reprint is labelled and suppresses drawer kick',reprintBytes.includes(Buffer.from('REPRINT'))&&!reprintBytes.includes(Buffer.from([0x1b,0x70,0x00,0x19,0xfa])),JSON.stringify(r.data));
 const receiptLines=reprintBytes.toString('utf8').split('\n');
 ck('receipt keeps ordinary item and amount on one compact line',receiptLines.some((text)=>text.includes(line.name)&&text.includes((line.price*line.qty/100).toFixed(2))),receiptLines.join(' | '));

 r=await admin.get('/api/backups/status');ck('owner can see backup health',r.status===200&&r.data.stale===true&&!r.data.latest,JSON.stringify(r.data));
 r=await admin.post('/api/backups/run',{});ck('owner can create verified hot backup',r.status===200&&r.data.ok&&r.data.status.latest&&!r.data.status.stale,JSON.stringify(r.data));
 r=await admin.post('/api/backups/verify',{});ck('owner can run read-only restore verification',r.status===200&&/integrity ok/i.test(r.data.output),JSON.stringify(r.data));
 r=await seller.get('/api/backups/status');ck('seller cannot read backup paths/status',r.status===403,JSON.stringify(r.data));
 const audit=await admin.get('/api/audit?limit=100');
 ck('approval use is audit logged',audit.data.some((x)=>x.action==='approval.use'&&/approved POST/.test(x.detail||'')));
 console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);process.exit(failed?1:0);
})().catch((e)=>{console.error('\nOPERATIONS TEST CRASH:',e);process.exit(2);});
