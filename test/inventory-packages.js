'use strict';
/* Phase 4 package conversion and structured stock-ledger regressions. */
const BASE=process.env.BASE;let passed=0,failed=0;
const ck=(name,ok,detail='')=>{if(ok){passed++;console.log('  ✓',name);}else{failed++;console.error('  ✗',name,detail);}};
const mk=()=>{let cookie='';const req=async(method,path,body)=>{const res=await fetch(BASE+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});const sc=res.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];const ct=res.headers.get('content-type')||'';return{status:res.status,data:ct.includes('json')?await res.json():await res.text()};};return{get:(p)=>req('GET',p),post:(p,b)=>req('POST',p,b),put:(p,b)=>req('PUT',p,b)};};

(async()=>{
  console.log('\n=== Phase 4 inventory packages and ledger ===\n');
  const admin=mk(),seller=mk();await admin.post('/api/login',{pin:'0000'});await seller.post('/api/login',{pin:'1234'});
  const boot=(await admin.get('/api/bootstrap')).data;await seller.post('/api/shifts',{opening_float:0,opening_mpesa:0,opening_card:0});
  const product=(await admin.post('/api/menu-items',{name:'Package Test Beer 500ml',category_id:boot.categories[0].id,
    price:250,cost:180,sku:'PKG-BEER',barcode:'616888000001',volume_ml:500,opening_qty:100,min_qty:10,unit:'bottle'})).data;
  ck('opening stock remains supported',product.stock_qty===100,JSON.stringify(product));
  let moves=(await admin.get('/api/stock-moves?limit=20')).data;
  const opening=moves.find((m)=>m.stock_item_id===product.stock_item_id&&m.movement_type==='OPENING_STOCK');
  ck('opening stock has before/after audit fields',opening&&opening.qty_before===0&&opening.qty_after===100&&opening.delta===100,JSON.stringify(opening));

  let r=await admin.post('/api/stock-packages',{stock_item_id:product.stock_item_id,name:'Crate of 24',units_per_package:24,
    sku:'PKG-BEER-CRATE',barcode:'616888000024',purchase_cost:12000,sale_price:15000,saleable:true});
  const crate=r.data;
  ck('owner defines deterministic crate conversion',r.status===200&&crate.units_per_package===24&&crate.purchase_cost===1200000&&crate.saleable===1,JSON.stringify(r.data));
  r=await admin.post('/api/stock-packages',{stock_item_id:product.stock_item_id,name:'Duplicate',units_per_package:12,barcode:'616888000001'});
  ck('package barcode cannot collide with product barcode',r.status===400&&/already in use/i.test(r.data.error),JSON.stringify(r.data));
  r=await seller.get('/api/stock-packages');
  ck('seller can use package conversions operationally',r.status===200&&r.data.some((p)=>p.id===crate.id));
  const refreshed=(await admin.get('/api/bootstrap')).data;
  ck('package metadata is included in bootstrap',refreshed.stock_packages.some((p)=>p.id===crate.id));

  const supplier=(await admin.post('/api/suppliers',{name:'Package Test Distributor'})).data;
  r=await seller.post('/api/goods-receipts',{supplier_id:supplier.id,invoice_no:'PKG-INV-001',payment_method:'other',
    idempotency_key:'pkg-delivery-001',items:[{stock_item_id:product.stock_item_id,package_id:crate.id,qty:2}]});
  const receipt=r.data;
  ck('two crates receive forty-eight base bottles',r.status===200&&receipt.total_cost===2400000,JSON.stringify(receipt));
  let stock=(await seller.get('/api/stock')).data.find((x)=>x.id===product.stock_item_id);
  ck('package receipt updates canonical base stock',stock.qty===148,JSON.stringify(stock));
  const detail=await seller.get('/api/goods-receipts/'+receipt.id);
  ck('purchase snapshots package conversion',detail.status===200&&detail.data.items[0].package_qty===2&&
    detail.data.items[0].units_per_package===24&&detail.data.items[0].qty===48,JSON.stringify(detail.data));
  r=await seller.post('/api/goods-receipts',{supplier_id:supplier.id,invoice_no:'IGNORED-RETRY',payment_method:'other',
    idempotency_key:'pkg-delivery-001',items:[{stock_item_id:product.stock_item_id,package_id:crate.id,qty:2}]});
  ck('purchase retry is idempotent',r.status===200&&r.data.idempotent_replay===true&&r.data.id===receipt.id,JSON.stringify(r.data));
  stock=(await seller.get('/api/stock')).data.find((x)=>x.id===product.stock_item_id);
  ck('purchase retry does not duplicate stock',stock.qty===148,String(stock.qty));
  moves=(await seller.get('/api/stock-moves?limit=20')).data;
  const purchase=moves.find((m)=>m.reference_id===receipt.id&&m.movement_type==='PURCHASE');
  ck('purchase movement links document and before/after',purchase&&purchase.qty_before===100&&purchase.qty_after===148&&
    purchase.reference_code==='PKG-INV-001',JSON.stringify(purchase));

  let sale=(await seller.post('/api/orders',{})).data;
  r=await seller.post(`/api/orders/${sale.id}/items`,{items:[{menu_item_id:product.id,package_id:crate.id,qty:1}]});
  ck('sale accepts configured crate package',r.status===200&&r.data.items[0].stock_factor===24&&
    r.data.items[0].price===1500000&&/Crate of 24/.test(r.data.items[0].name),JSON.stringify(r.data));
  r=await seller.post(`/api/orders/${sale.id}/pay`,{method:'cash',amount:15000,tendered:15000,idempotency_key:'pkg-sale-crate'});
  ck('crate sale closes normally',r.status===200&&r.data.order.status==='closed',JSON.stringify(r.data));
  stock=(await seller.get('/api/stock')).data.find((x)=>x.id===product.stock_item_id);
  ck('crate sale deducts twenty-four base bottles',stock.qty===124,String(stock.qty));
  moves=(await seller.get('/api/stock-moves?limit=20')).data;
  const packageSale=moves.find((m)=>m.reference_id===sale.id&&m.movement_type==='SALE');
  ck('crate sale movement is structured',packageSale&&packageSale.delta===-24&&packageSale.qty_before===148&&packageSale.qty_after===124,JSON.stringify(packageSale));

  sale=(await seller.post('/api/orders',{})).data;
  r=await seller.post(`/api/orders/${sale.id}/items`,{items:[{menu_item_id:product.id,qty:12}]});
  await seller.post(`/api/orders/${sale.id}/pay`,{method:'cash',amount:3000,tendered:3000,idempotency_key:'pkg-sale-bottles'});
  stock=(await seller.get('/api/stock')).data.find((x)=>x.id===product.stock_item_id);
  ck('twelve bottle sales use the same canonical stock',stock.qty===112,String(stock.qty));

  r=await admin.post(`/api/stock/${product.stock_item_id}/adjust`,{delta:-2,movement_type:'BREAKAGE',reason:'Two bottles broken',reference:'BRK-001'});
  ck('breakage adjustment updates stock',r.status===200&&r.data.qty===110,JSON.stringify(r.data));
  moves=(await admin.get('/api/stock-moves?limit=20')).data;
  const breakage=moves.find((m)=>m.movement_type==='BREAKAGE'&&m.reference_code==='BRK-001');
  ck('breakage movement is typed and auditable',breakage&&breakage.qty_before===112&&breakage.qty_after===110&&breakage.user_name,JSON.stringify(breakage));

  const other=(await admin.post('/api/menu-items',{name:'Other Package Product 750ml',category_id:boot.categories[0].id,
    price:500,cost:300,volume_ml:750,opening_qty:5,unit:'bottle'})).data;
  sale=(await seller.post('/api/orders',{})).data;
  r=await seller.post(`/api/orders/${sale.id}/items`,{items:[{menu_item_id:other.id,package_id:crate.id,qty:1}]});
  ck('package cannot be applied to unrelated product stock',r.status===400&&/does not belong/i.test(r.data.error),JSON.stringify(r.data));

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);process.exit(failed?1:0);
})().catch((e)=>{console.error('\nPACKAGE TEST CRASH:',e);process.exit(2);});
