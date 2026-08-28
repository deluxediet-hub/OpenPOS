'use strict';
/* Phase 5 configurable count scope and authoritative reconciliation regressions. */
const BASE=process.env.BASE;let passed=0,failed=0;
const ck=(name,ok,detail='')=>{if(ok){passed++;console.log('  ✓',name);}else{failed++;console.error('  ✗',name,detail);}};
const mk=()=>{let cookie='';const req=async(method,path,body)=>{const res=await fetch(BASE+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});const sc=res.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];const ct=res.headers.get('content-type')||'';return{status:res.status,data:ct.includes('json')?await res.json():await res.text()};};return{get:(p)=>req('GET',p),post:(p,b)=>req('POST',p,b),put:(p,b)=>req('PUT',p,b)};};
const completeExact=async(client,id)=>{const count=(await client.get('/api/stock-counts/'+id)).data;return client.post(`/api/stock-counts/${id}/complete`,{items:count.items.map((x)=>({stock_item_id:x.stock_item_id,counted:x.expected,added_qty:0}))});};

(async()=>{
  console.log('\n=== Phase 5 count policy and reconciliation ===\n');
  const admin=mk(),seller=mk();await admin.post('/api/login',{pin:'0000'});await seller.post('/api/login',{pin:'1234'});
  const boot=(await admin.get('/api/bootstrap')).data;
  ck('default close policy does not force a physical count',boot.settings.stock_count_close_policy==='none',boot.settings.stock_count_close_policy);

  let shift=(await seller.post('/api/shifts',{opening_float:100,opening_mpesa:50,opening_card:25})).data;
  let r=await seller.post(`/api/shifts/${shift.id}/reconciliation-preview`,{counted_cash:100,counted_mpesa:50,counted_card:25});
  ck('preview uses authoritative no-count classification',r.status===200&&r.data.status==='TENDERS BALANCED — STOCK NOT COUNTED'&&
    r.data.stock_retail_variance===null&&r.data.overall_variance===null&&!r.data.requires_note,JSON.stringify(r.data));
  r=await seller.post(`/api/shifts/${shift.id}/close`,{counted_cash:100,counted_mpesa:50,counted_card:25});
  ck('daily tender reconciliation closes without a count when configured',r.status===200&&r.data.stock_coverage==='none'&&
    r.data.overall_variance===null&&r.data.reconciliation.status==='TENDERS BALANCED — STOCK NOT COUNTED',JSON.stringify(r.data));

  r=await admin.put('/api/settings',{stock_count_close_policy:'invalid'});
  ck('invalid close-count policy is rejected',r.status===400&&/none, any or full/i.test(r.data.error),JSON.stringify(r.data));
  await admin.put('/api/settings',{stock_count_close_policy:'full'});
  shift=(await seller.post('/api/shifts',{opening_float:0,opening_mpesa:0,opening_card:0})).data;
  const category=boot.categories[0];
  r=await seller.post('/api/stock-counts',{reference:'CATEGORY-CLOSE',count_type:'category',category_id:category.id,for_close:true});
  ck('category count selects a scoped product set',r.status===200&&r.data.count_type==='category'&&r.data.coverage_count>0&&r.data.coverage_ratio<1,JSON.stringify(r.data));
  await completeExact(seller,r.data.id);
  let close=await seller.post(`/api/shifts/${shift.id}/close`,{counted_cash:0,counted_mpesa:0,counted_card:0});
  ck('full-count policy rejects a partial category count',close.status===400&&/full closing stock count/i.test(close.data.error),JSON.stringify(close.data));

  r=await seller.post('/api/stock-counts',{reference:'FULL-CLOSE',count_type:'full',for_close:true});
  ck('full count covers the complete stock list',r.status===200&&r.data.coverage_count===r.data.total_stock_items&&r.data.coverage_ratio===1,JSON.stringify(r.data));
  await completeExact(seller,r.data.id);
  close=await seller.post(`/api/shifts/${shift.id}/close`,{counted_cash:0,counted_mpesa:0,counted_card:0});
  ck('full-count policy closes with fully balanced status',close.status===200&&close.data.reconciliation.status==='FULLY BALANCED'&&
    close.data.stock_coverage==='full'&&close.data.stock_count_type==='full',JSON.stringify(close.data));

  await admin.put('/api/settings',{stock_count_close_policy:'any'});
  shift=(await seller.post('/api/shifts',{opening_float:0,opening_mpesa:0,opening_card:0})).data;
  const selectedProduct=boot.menu[0],selectedId=selectedProduct.stock_item_id;
  r=await seller.post('/api/stock-counts',{reference:'SPOT-CLOSE',count_type:'spot',stock_item_ids:[selectedId],scope_label:'High value shelf',for_close:true});
  ck('spot count supports selected products',r.status===200&&r.data.count_type==='spot'&&r.data.coverage_count===1,JSON.stringify(r.data));
  let count=(await seller.get('/api/stock-counts/'+r.data.id)).data;
  await seller.post(`/api/stock-counts/${count.id}/complete`,{items:[{stock_item_id:selectedId,counted:count.items[0].expected-1,added_qty:0}]});
  const preview=await seller.post(`/api/shifts/${shift.id}/reconciliation-preview`,{counted_cash:selectedProduct.price/100,counted_mpesa:0,counted_card:0});
  ck('partial-count preview is explicitly scoped',preview.status===200&&preview.data.stock_coverage==='partial'&&
    preview.data.status==='SCOPED RECONCILED — POSSIBLE UNRECORDED SALES'&&preview.data.overall_variance===0,JSON.stringify(preview.data));
  close=await seller.post(`/api/shifts/${shift.id}/close`,{counted_cash:selectedProduct.price/100,counted_mpesa:0,counted_card:0,
    reconciliation_note:'Controlled scoped variance test'});
  ck('any-count policy accepts scoped count without claiming full balance',close.status===200&&close.data.stock_coverage==='partial'&&
    /SCOPED RECONCILED/.test(close.data.reconciliation.status),JSON.stringify(close.data));

  await admin.put('/api/settings',{stock_count_close_policy:'none'});
  shift=(await seller.post('/api/shifts',{opening_float:0,opening_mpesa:0,opening_card:0})).data;
  r=await seller.post('/api/stock-counts',{reference:'CYCLE-NOT-CLOSE',count_type:'cycle',stock_item_ids:[selectedId],scope_label:'Weekly cycle',for_close:false});
  ck('cycle count can run without becoming the closing count',r.status===200&&r.data.for_close===0,JSON.stringify(r.data));
  let current=await seller.get('/api/shifts/current');
  ck('non-closing cycle count leaves till open',current.data.shift.status==='open',JSON.stringify(current.data.shift));
  await admin.post(`/api/stock/${selectedId}/adjust`,{delta:1,reason:'Concurrent cycle-count test'});
  let completion=await completeExact(seller,r.data.id);
  ck('non-closing count rejects a stale stock snapshot',completion.status===409&&/stock changed/i.test(completion.data.error),JSON.stringify(completion.data));
  await admin.post(`/api/stock/${selectedId}/adjust`,{delta:-1,reason:'Restore cycle-count fixture'});
  completion=await completeExact(seller,r.data.id);
  ck('cycle count completes after stock returns to its snapshot',completion.status===200,JSON.stringify(completion.data));
  current=await seller.get('/api/shifts/current');
  ck('non-closing count is not misreported as close coverage',current.data.stocktake===null&&current.data.stock_coverage==='none',JSON.stringify(current.data));
  close=await seller.post(`/api/shifts/${shift.id}/close`,{counted_cash:0,counted_mpesa:0,counted_card:0});
  ck('till still closes under no-count policy',close.status===200&&close.data.reconciliation.stock_coverage==='none',JSON.stringify(close.data));

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);process.exit(failed?1:0);
})().catch((e)=>{console.error('\nRECONCILIATION TEST CRASH:',e);process.exit(2);});
