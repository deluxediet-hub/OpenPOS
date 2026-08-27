'use strict';
/* Read-only restore drill: open a selected backup, run SQLite integrity_check,
   and verify the core business tables before an operator relies on it. */
const fs=require('fs'),path=require('path'),Database=require('better-sqlite3');
const dir=process.env.POS_BACKUP_DIR||path.join(__dirname,'..','backups');
let file=process.argv[2]&&path.resolve(process.argv[2]);
if(!file){const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(x=>/^pos-.*\.db$/.test(x)).map(x=>path.join(dir,x)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs):[];file=files[0];}
if(!file||!fs.existsSync(file)){console.error('No backup found to verify');process.exit(1);}
let db;
try{db=new Database(file,{readonly:true,fileMustExist:true});const result=db.pragma('integrity_check',{simple:true});if(result!=='ok')throw Error('integrity_check: '+result);
const required=['settings','users','menu_items','orders','order_items','payments','stock_items','stock_moves','shifts','audit_log'];
const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));const missing=required.filter(x=>!tables.has(x));if(missing.length)throw Error('missing tables: '+missing.join(', '));
const stats={orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,products:db.prepare('SELECT COUNT(*) n FROM menu_items').get().n,stock:db.prepare('SELECT COUNT(*) n FROM stock_items').get().n};
console.log(`Backup verified: ${file}`);console.log(`integrity ok · ${stats.orders} orders · ${stats.products} products · ${stats.stock} stock records`);
}catch(e){console.error('Backup verification failed:',e.message);process.exitCode=1;}finally{if(db)db.close();}
