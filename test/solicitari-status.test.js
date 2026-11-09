const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrders, publicParcel, snapshot, authorized, statusHandler } = require('../solicitari-status');
const key='integration-test-key-with-more-than-32-characters';
const base={awb:'12345678901',order_id:'7',order_name:'#7',first_scan_at:'2026-11-09T10:00:00Z',packed:0,phone:'PRIVATE',items_json:'PRIVATE',client_note:'PRIVATE'};
test('exact AWB and order match; mismatched order and scanner suffix never leak records',()=>{
 const db={getAwb:awb=>awb===base.awb?base:null};
 assert.equal(snapshot(db,normalizeOrders({orders:[{order_id:'gid://shopify/Order/7',order_name:'#7',awbs:[base.awb]}]})).orders[0].parcels.length,1);
 for(const [order_id,awb] of [['8',base.awb],['7',base.awb+'000']])assert.equal(snapshot(db,normalizeOrders({orders:[{order_id,order_name:'#7',awbs:[awb]}]})).orders[0].parcels.length,0);
 const result=JSON.stringify(snapshot(db,[{order_id:'7',order_name:'7',awbs:[base.awb]}]));assert.ok(!result.includes('PRIVATE'));assert.ok(!result.includes('phone'));
});
test('legacy rows require exact order name and exact AWB',()=>{
 const db={getAwb:()=>({...base,order_id:null})};
 assert.equal(snapshot(db,[{order_id:'7',order_name:'7',awbs:[base.awb]}]).orders[0].parcels.length,1);
 assert.equal(snapshot(db,[{order_id:'8',order_name:'8',awbs:[base.awb]}]).orders[0].parcels.length,0);
});
test('packed and courier delivered do not claim physical handoff',()=>{
 const p=publicParcel({...base,packed:1,packed_at:'2026-11-09T10:05:00Z',sameday_status:'Livrat'});
 assert.equal(p.warehouse_state,'packed');assert.equal(p.handoff_confirmed,false);assert.equal(p.operator,null);
 assert.equal(publicParcel({...base,packed:1,first_scan_at:null}).warehouse_state,'packed_unverified');
 assert.equal(publicParcel({...base,packed:1,packed_at:base.first_scan_at}).warehouse_state,'packed_unverified');
});
test('return, cancellation and missing stock take precedence over old packed flag',()=>{
 assert.equal(publicParcel({...base,packed:1,stock_missing:1}).warehouse_state,'stock_missing');
 assert.equal(publicParcel({...base,packed:1,cancelled:1}).warehouse_state,'cancelled');
 assert.equal(publicParcel({...base,cancelled:1,return_received:1}).warehouse_state,'return_received');
});
test('separate secret required; absent, short, query-like or wrong credentials fail',()=>{
 assert.ok(authorized('Bearer '+key,key));for(const [h,s] of [[undefined,key],['Bearer wrong',key],['Bearer short','short'],['?token='+key,key],['Bearer '+key,undefined]])assert.equal(authorized(h,s),false);
});
test('bounded request, duplicate IDs and malformed identifiers rejected',()=>{
 for(const orders of [[],Array(41).fill({}),[{order_id:'7',order_name:'#7',awbs:['x']}],[{order_id:'7',order_name:'#7',awbs:[]},{order_id:'7',order_name:'#7',awbs:[]}]] )assert.throws(()=>normalizeOrders({orders}));
});
test('HTTP handler fails closed before database reads and hides internal errors',()=>{
 let reads=0;const db={getAwb(){reads++;throw Error('PRIVATE')}};const handler=statusHandler(db,()=>key);
 const invoke=(auth,body)=>{const res={code:200,headers:{},set(k,v){this.headers[k]=v;return this},status(n){this.code=n;return this},json(v){this.body=v;return this}};handler({get:()=>auth,body},res);return res};
 assert.equal(invoke('Bearer wrong',{}).code,401);assert.equal(reads,0);
 assert.equal(invoke('Bearer '+key,{}).code,400);assert.equal(reads,0);
 const r=invoke('Bearer '+key,{orders:[{order_id:'7',order_name:'#7',awbs:[base.awb]}]});assert.equal(r.code,503);assert.equal(r.headers['Cache-Control'],'no-store');assert.ok(!JSON.stringify(r.body).includes('PRIVATE'));
});
